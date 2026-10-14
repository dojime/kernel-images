package cdpmonitor

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/kernel/kernel-images/server/lib/events"
	"github.com/kernel/kernel-images/server/lib/oapi"
)

const (
	networkHeaderWait       = time.Second
	maxOrphanExchanges      = 8192
	maxExtraInfoPerExchange = 64
	durableBodyBufferSize   = 10 * 1024 * 1024
)

// Chrome emits base events and ExtraInfo on independent streams. Redirects reuse
// request IDs; only hops whose response advertises ExtraInfo consume those queues.
// All exchange and hop fields are protected by pendReqMu.
type networkExchange struct {
	addedAt   time.Time
	hops      []*networkHop
	requests  []json.RawMessage
	responses []cdpNetworkResponseReceivedExtraInfoParams
	failed    bool
}

type networkHop struct {
	exchange         *networkExchange
	request          oapi.BrowserNetworkRequestEventData
	source           oapi.BrowserEventSource
	known            bool
	hasExtra         bool
	requestHeaders   json.RawMessage
	responseExtra    *cdpNetworkResponseReceivedExtraInfoParams
	requestReady     chan struct{}
	responseReady    chan struct{}
	requestMatched   bool
	responseMatched  bool
	requestPublished bool
}

func (m *Monitor) exchangeLocked(key networkRequestKey) *networkExchange {
	e := m.networkExchanges[key]
	if e == nil {
		e = &networkExchange{addedAt: time.Now()}
		m.networkExchanges[key] = e
	}
	return e
}

func (m *Monitor) queueNetworkRequestLocked(key networkRequestKey, request oapi.BrowserNetworkRequestEventData, info targetInfo) *networkHop {
	e := m.exchangeLocked(key)
	metadata := targetMetadata(info)
	h := &networkHop{
		exchange:      e,
		request:       request,
		source:        oapi.BrowserEventSource{Kind: oapi.Cdp, Metadata: &metadata},
		requestReady:  make(chan struct{}),
		responseReady: make(chan struct{}),
	}
	e.hops = append(e.hops, h)
	return h
}

func (m *Monitor) handleRequestExtraInfo(p cdpNetworkRequestWillBeSentExtraInfoParams, sessionID string) {
	key := networkRequestKey{sessionID, p.RequestID}
	m.pendReqMu.Lock()
	defer m.pendReqMu.Unlock()
	if m.networkExchanges[key] == nil && len(m.networkExchanges) >= maxOrphanExchanges {
		return
	}
	e := m.exchangeLocked(key)
	if len(e.requests) >= maxExtraInfoPerExchange {
		return
	}
	e.requests = append(e.requests, p.Headers)
	e.matchHeaders()
}

func (m *Monitor) handleResponseExtraInfo(p cdpNetworkResponseReceivedExtraInfoParams, sessionID string) {
	key := networkRequestKey{sessionID, p.RequestID}
	m.pendReqMu.Lock()
	defer m.pendReqMu.Unlock()
	if m.networkExchanges[key] == nil && len(m.networkExchanges) >= maxOrphanExchanges {
		return
	}
	e := m.exchangeLocked(key)
	if len(e.responses) >= maxExtraInfoPerExchange {
		return
	}
	e.responses = append(e.responses, p)
	e.matchHeaders()
}

func (m *Monitor) resolveNetworkHeadersLocked(h *networkHop, hasExtra bool) {
	if h == nil {
		return
	}
	h.known, h.hasExtra = true, hasExtra
	h.exchange.matchHeaders()
}

func (m *Monitor) resolveFailedHeadersLocked(h *networkHop) {
	if h == nil {
		return
	}
	h.exchange.failed = true
	// CORS failures can have ExtraInfo without a responseReceived event.
	if !h.known {
		h.known, h.hasExtra = true, true
	}
	h.exchange.matchHeaders()
	if h.requestPublished {
		delete(m.networkExchanges, networkRequestKey{h.request.SessionId, h.request.RequestId})
	}
}

func (e *networkExchange) matchHeaders() {
	for _, h := range e.hops {
		if !h.known {
			break
		}
		if h.requestMatched {
			continue
		}
		if h.hasExtra {
			if len(e.requests) == 0 {
				break
			}
			h.requestHeaders, e.requests = e.requests[0], e.requests[1:]
		}
		h.requestMatched = true
		close(h.requestReady)
	}
	for _, h := range e.hops {
		if !h.known {
			break
		}
		if h.responseMatched {
			continue
		}
		if h.hasExtra {
			if len(e.responses) == 0 {
				break
			}
			extra := e.responses[0]
			h.responseExtra, e.responses = &extra, e.responses[1:]
		}
		h.responseMatched = true
		close(h.responseReady)
	}
}

func waitNetworkHeaders(ctx context.Context, ready ...<-chan struct{}) {
	timer := time.NewTimer(networkHeaderWait)
	defer timer.Stop()
	for _, ch := range ready {
		select {
		case <-ch:
		case <-ctx.Done():
			return
		case <-timer.C:
			return
		}
	}
}

func (m *Monitor) publishNetworkRequest(ctx context.Context, key networkRequestKey, h *networkHop) {
	m.telemetryWg.Go(func() {
		waitNetworkHeaders(ctx, h.requestReady)
		m.pendReqMu.Lock()
		payload := h.request
		if h.requestHeaders != nil {
			payload.Headers = nil
			_ = json.Unmarshal(h.requestHeaders, &payload.Headers)
		}
		h.requestPublished = true
		if h.exchange.failed && m.networkExchanges[key] == h.exchange {
			delete(m.networkExchanges, key)
		}
		m.pendReqMu.Unlock()
		data, _ := json.Marshal(payload)
		m.publishEvent(EventNetworkRequest, events.Network, h.source, "Network.requestWillBeSent", data, key.sessionID)
	})
}

func (m *Monitor) emitNetworkResponse(ctx context.Context, key networkRequestKey, state networkReqState, info targetInfo, redirect bool) {
	m.telemetryWg.Go(func() {
		// Fetch before waiting for ExtraInfo so header ordering cannot delay retrieval.
		var body string
		var bodyErr error
		if !redirect {
			body, bodyErr = m.fetchResponseBody(ctx, key.requestID, key.sessionID, state)
		}
		h := state.hop
		if h != nil {
			waitNetworkHeaders(ctx, h.requestReady, h.responseReady)
		}
		var headers oapi.BrowserHttpHeaders
		_ = json.Unmarshal(state.resHeaders, &headers)
		payload := oapi.BrowserNetworkResponseEventData{
			SessionId:    key.sessionID,
			TargetId:     info.targetID,
			TargetType:   oapi.BrowserTargetType(info.targetType),
			FrameId:      ptrOf(state.frameID),
			LoaderId:     ptrOf(state.loaderID),
			Url:          ptrOf(state.url),
			NavSeq:       state.navSeq,
			RequestId:    key.requestID,
			Method:       state.method,
			Status:       state.status,
			Headers:      headers,
			StatusText:   optPtr(state.statusText),
			MimeType:     optPtr(state.mimeType),
			ResourceType: optPtr(state.resourceType),
			Body:         optPtr(body),
		}
		if bodyErr != nil {
			payload.BodyError = ptrOf(bodyErr.Error())
		}
		metadata := targetMetadata(info)
		source := oapi.BrowserEventSource{Kind: oapi.Cdp, Metadata: &metadata}
		if h != nil {
			source = h.source
			m.pendReqMu.Lock()
			if h.requestHeaders != nil {
				var requestHeaders oapi.BrowserHttpHeaders
				_ = json.Unmarshal(h.requestHeaders, &requestHeaders)
				payload.RequestHeaders = &requestHeaders
			}
			if h.responseExtra != nil {
				payload.Headers = nil
				_ = json.Unmarshal(h.responseExtra.Headers, &payload.Headers)
				payload.Status = h.responseExtra.StatusCode
				if payload.Status != state.status {
					payload.EffectiveStatus = ptrOf(state.status)
					payload.StatusText = optPtr(http.StatusText(payload.Status))
				}
			}
			if !redirect && m.networkExchanges[key] == h.exchange {
				delete(m.networkExchanges, key)
			}
			m.pendReqMu.Unlock()
		}
		data, _ := json.Marshal(payload)
		event := "Network.loadingFinished"
		if redirect {
			event = "Network.requestWillBeSent"
		}
		m.publishEvent(EventNetworkResponse, events.Network, source, event, data, key.sessionID)
	})
}

func (m *Monitor) finishNetworkRequest(state networkReqState) {
	if cs := m.computedFor(state.sessionID); cs != nil {
		m.pendReqMu.Lock()
		defer m.pendReqMu.Unlock()
		cs.mu.Lock()
		sameNavigation := state.countedNavSeq == cs.navSeq
		cs.mu.Unlock()
		if sameNavigation {
			cs.onLoadingFinished()
		}
	}
}

func (m *Monitor) configureBodyCapture(ctx context.Context, sessionID string, enabled bool) error {
	size := 0
	if enabled {
		size = durableBodyBufferSize
	}
	_, err := m.send(ctx, "Network.enable", map[string]any{"enableDurableMessages": enabled, "maxTotalBufferSize": size}, sessionID)
	return err
}
