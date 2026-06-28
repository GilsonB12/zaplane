package whatsapp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Client struct {
	http         *http.Client
	graphVersion string
}

func NewClient(graphVersion string) *Client {
	return &Client{
		http:         &http.Client{Timeout: 20 * time.Second},
		graphVersion: graphVersion,
	}
}

// SendResult resume a resposta da Meta.
type SendResult struct {
	WAMessageID string
	Retryable   bool
	ErrCode     string
	ErrDetail   string
}

type metaSuccess struct {
	Messages []struct {
		ID string `json:"id"`
	} `json:"messages"`
}

type metaError struct {
	Error struct {
		Message   string `json:"message"`
		Type      string `json:"type"`
		Code      int    `json:"code"`
		Subcode   int    `json:"error_subcode"`
		FBTraceID string `json:"fbtrace_id"`
	} `json:"error"`
}

// Send faz POST /{phone_number_id}/messages na Graph API.
// payload já é o objeto pronto ({messaging_product, to, type, template/text...}).
func (c *Client) Send(ctx context.Context, phoneNumberID, token string, payload []byte) SendResult {
	url := fmt.Sprintf("https://graph.facebook.com/%s/%s/messages", c.graphVersion, phoneNumberID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return SendResult{Retryable: false, ErrCode: "build_request", ErrDetail: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		// erro de rede → retentável
		return SendResult{Retryable: true, ErrCode: "network", ErrDetail: err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		var ok metaSuccess
		if err := json.Unmarshal(body, &ok); err == nil && len(ok.Messages) > 0 {
			return SendResult{WAMessageID: ok.Messages[0].ID}
		}
		return SendResult{WAMessageID: ""} // aceito, sem id (raro)
	}

	// erro: decide retentável
	var me metaError
	_ = json.Unmarshal(body, &me)
	retryable := resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500
	return SendResult{
		Retryable: retryable,
		ErrCode:   fmt.Sprintf("http_%d_code_%d", resp.StatusCode, me.Error.Code),
		ErrDetail: me.Error.Message,
	}
}
