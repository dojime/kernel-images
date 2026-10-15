package api

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/kernel/kernel-images/server/lib/logger"
	"github.com/kernel/kernel-images/server/lib/oapi"
)

const (
	// defaultBrowserReplExecutor runs calls that name no executor. It always
	// exists, attaches to an existing page instead of owning a tab, owns the
	// custom WebMCP tools, and does not count toward maxBrowserReplExecutors.
	defaultBrowserReplExecutor = "default"

	maxBrowserReplExecutors = 8

	// browserReplExecutorShutdownGrace bounds each shutdown phase: retiring
	// executors, then closing their tabs.
	browserReplExecutorShutdownGrace = 3 * time.Second
)

var errBrowserReplExecutorsShutDown = errors.New("browser REPL executors are shutting down")

type browserReplExecutorLimitError struct {
	executors []browserReplExecutorInfo
}

func (e *browserReplExecutorLimitError) Error() string {
	return fmt.Sprintf("named executor limit (%d) reached; delete one with DELETE /repl/executors/{name}", maxBrowserReplExecutors)
}

// browserReplExecutorInfo is a point-in-time copy of an executor's listed
// fields.
type browserReplExecutorInfo struct {
	name       string
	createdAt  time.Time
	lastUsedAt time.Time
	busy       bool
	targetID   string
}

func (m *browserReplManager) info() browserReplExecutorInfo {
	m.infoMu.Lock()
	defer m.infoMu.Unlock()
	return browserReplExecutorInfo{
		name:       m.name,
		createdAt:  m.createdAt,
		lastUsedAt: m.lastUsedAt,
		busy:       m.busy,
		targetID:   m.homeTargetID,
	}
}

// browserReplExecutors holds the default executor and the named executors
// created by POST /repl. Each executor has its own child process, so calls
// on different executors run concurrently and a timeout or crash only ends
// that executor's state.
type browserReplExecutors struct {
	def  *browserReplManager
	tabs executorTabs

	mu     sync.Mutex
	named  map[string]*browserReplManager
	closed bool
}

func newBrowserReplExecutors(def *browserReplManager, tabs executorTabs) *browserReplExecutors {
	return &browserReplExecutors{
		def:   def,
		tabs:  tabs,
		named: make(map[string]*browserReplManager),
	}
}

// executorFor returns the named executor, creating it if there is room.
func (x *browserReplExecutors) executorFor(name string) (*browserReplManager, error) {
	if name == defaultBrowserReplExecutor {
		return x.def, nil
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.closed {
		return nil, errBrowserReplExecutorsShutDown
	}
	if m, ok := x.named[name]; ok {
		return m, nil
	}
	if len(x.named) >= maxBrowserReplExecutors {
		return nil, &browserReplExecutorLimitError{executors: x.listLocked()}
	}
	// Named sockets sit next to the default socket so tests that relocate it
	// relocate every executor.
	socket := filepath.Join(filepath.Dir(browserReplSocketPath()), "browser-repl-"+uuid.NewString()+".sock")
	m := newNamedBrowserReplManager(name, socket, x.tabs)
	x.named[name] = m
	return m, nil
}

// remove drops m if it is still the executor registered under its name, and
// reports whether it did.
func (x *browserReplExecutors) remove(m *browserReplManager) bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.named[m.name] != m {
		return false
	}
	delete(x.named, m.name)
	return true
}

func (x *browserReplExecutors) list() []browserReplExecutorInfo {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.listLocked()
}

// listLocked returns the default executor first, then the named executors
// oldest first. The caller must hold mu.
func (x *browserReplExecutors) listLocked() []browserReplExecutorInfo {
	named := make([]browserReplExecutorInfo, 0, len(x.named))
	for _, m := range x.named {
		named = append(named, m.info())
	}
	slices.SortFunc(named, func(a, b browserReplExecutorInfo) int {
		return a.createdAt.Compare(b.createdAt)
	})
	return append([]browserReplExecutorInfo{x.def.info()}, named...)
}

// Shutdown retires every named executor and closes their tabs, which a later
// API process would have no way to reach. The default executor is shut down
// separately.
func (x *browserReplExecutors) Shutdown(ctx context.Context) {
	x.mu.Lock()
	x.closed = true
	named := make([]*browserReplManager, 0, len(x.named))
	for _, m := range x.named {
		named = append(named, m)
	}
	x.named = make(map[string]*browserReplManager)
	x.mu.Unlock()

	// Retiring and closing get separate budgets, so slow process exits cannot
	// use up the time needed to close the tabs they leave behind.
	retireCtx, cancelRetire := context.WithTimeout(ctx, browserReplExecutorShutdownGrace)
	defer cancelRetire()
	targetIDs := make([]string, 0, len(named))
	for _, m := range named {
		if targetID := m.retire(retireCtx, errBrowserReplExecutorsShutDown); targetID != "" {
			targetIDs = append(targetIDs, targetID)
		}
	}

	closeCtx, cancelClose := context.WithTimeout(ctx, browserReplExecutorShutdownGrace)
	defer cancelClose()
	for _, targetID := range targetIDs {
		if err := x.tabs.Close(closeCtx, targetID); err != nil {
			logger.FromContext(ctx).Warn("failed to close browser REPL executor tab", "target_id", targetID, "error", err)
		}
	}
}

// ExecuteBrowserRepl implements POST /repl, routing the call to its executor.
func (s *ApiService) ExecuteBrowserRepl(ctx context.Context, request oapi.ExecuteBrowserReplRequestObject) (oapi.ExecuteBrowserReplResponseObject, error) {
	name := defaultBrowserReplExecutor
	if request.Body != nil && request.Body.Executor != nil {
		name = *request.Body.Executor
	}
	if !executorNamePattern.MatchString(name) {
		return oapi.ExecuteBrowserRepl400JSONResponse{
			BadRequestErrorJSONResponse: oapi.BadRequestErrorJSONResponse{
				Message: "executor name must match " + executorNamePattern.String(),
			},
		}, nil
	}

	m, err := s.browserReplExecutors.executorFor(name)
	var limitErr *browserReplExecutorLimitError
	if errors.As(err, &limitErr) {
		return oapi.ExecuteBrowserRepl409JSONResponse{
			Message:   limitErr.Error(),
			Executors: s.browserReplExecutorsJSON(ctx, limitErr.executors),
		}, nil
	}
	if err != nil {
		return nil, err
	}

	resp, err := m.Execute(ctx, request)
	if errors.Is(err, errBrowserReplDeleted) || errors.Is(err, errBrowserReplRestarted) {
		// The executor was deleted or restarted before this call reached its
		// runtime, so the call never ran.
		message := err.Error()
		return oapi.ExecuteBrowserRepl200JSONResponse{
			Success: false,
			Error:   &message,
		}, nil
	}
	if _, failed := resp.(oapi.ExecuteBrowserRepl500JSONResponse); failed && !m.isDefault() && m.info().targetID == "" {
		// A named executor that never got a tab has no state worth keeping;
		// drop it so it does not hold one of the limited slots.
		if s.browserReplExecutors.remove(m) {
			m.retire(ctx, errBrowserReplDeleted)
		}
	}
	return resp, err
}

// browserReplExecutorsJSON converts executors to API objects, adding the
// current URL of each executor's tab when the browser can report it.
func (s *ApiService) browserReplExecutorsJSON(ctx context.Context, executors []browserReplExecutorInfo) []oapi.BrowserReplExecutor {
	var urls map[string]string
	if slices.ContainsFunc(executors, func(e browserReplExecutorInfo) bool { return e.targetID != "" }) {
		urls = s.tabURLs(ctx)
	}
	out := make([]oapi.BrowserReplExecutor, 0, len(executors))
	for _, e := range executors {
		item := oapi.BrowserReplExecutor{
			Name:       e.name,
			Busy:       e.busy,
			CreatedAt:  e.createdAt,
			LastUsedAt: e.lastUsedAt,
		}
		if e.targetID != "" {
			targetID := e.targetID
			item.TargetId = &targetID
			if url, ok := urls[e.targetID]; ok {
				item.Url = &url
			}
		}
		out = append(out, item)
	}
	return out
}

func (s *ApiService) ListBrowserReplExecutors(ctx context.Context, _ oapi.ListBrowserReplExecutorsRequestObject) (oapi.ListBrowserReplExecutorsResponseObject, error) {
	return oapi.ListBrowserReplExecutors200JSONResponse{
		Executors: s.browserReplExecutorsJSON(ctx, s.browserReplExecutors.list()),
	}, nil
}

func (s *ApiService) DeleteBrowserReplExecutor(ctx context.Context, request oapi.DeleteBrowserReplExecutorRequestObject) (oapi.DeleteBrowserReplExecutorResponseObject, error) {
	if !executorNamePattern.MatchString(request.Name) {
		return oapi.DeleteBrowserReplExecutor400JSONResponse{
			BadRequestErrorJSONResponse: oapi.BadRequestErrorJSONResponse{
				Message: "executor name must match " + executorNamePattern.String(),
			},
		}, nil
	}
	if request.Name == defaultBrowserReplExecutor {
		s.browserRepl.restart(ctx)
		return oapi.DeleteBrowserReplExecutor204Response{}, nil
	}

	x := s.browserReplExecutors
	x.mu.Lock()
	m, ok := x.named[request.Name]
	x.mu.Unlock()
	if !ok || !x.remove(m) {
		return oapi.DeleteBrowserReplExecutor404JSONResponse{
			NotFoundErrorJSONResponse: oapi.NotFoundErrorJSONResponse{
				Message: fmt.Sprintf("executor %q not found", request.Name),
			},
		}, nil
	}
	targetID := m.retire(ctx, errBrowserReplDeleted)

	closeTab := request.Params.CloseTab == nil || *request.Params.CloseTab
	if closeTab && targetID != "" {
		if err := x.tabs.Close(ctx, targetID); err != nil {
			logger.FromContext(ctx).Error("failed to close browser REPL executor tab", "executor", request.Name, "error", err)
			return oapi.DeleteBrowserReplExecutor500JSONResponse{
				InternalErrorJSONResponse: oapi.InternalErrorJSONResponse{
					Message: fmt.Sprintf("executor deleted, but closing its tab %s failed: %v", targetID, err),
				},
			}, nil
		}
	}
	return oapi.DeleteBrowserReplExecutor204Response{}, nil
}
