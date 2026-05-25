// backend/internal/logging/logger_test.go
package logging

import (
	"bytes"
	"strings"
	"testing"
)

func TestLogger_Info(t *testing.T) {
	var buf bytes.Buffer
	l := New("TestComponent", &buf)
	l.Info("hello %s", "world")
	out := buf.String()
	if !strings.Contains(out, "[INFO]") {
		t.Errorf("expected [INFO] in output, got: %s", out)
	}
	if !strings.Contains(out, "[TestComponent]") {
		t.Errorf("expected [TestComponent] in output, got: %s", out)
	}
	if !strings.Contains(out, "hello world") {
		t.Errorf("expected 'hello world' in output, got: %s", out)
	}
}

func TestLogger_Error(t *testing.T) {
	var buf bytes.Buffer
	l := New("Proposals", &buf)
	l.Error("failed to save: %v", "timeout")
	out := buf.String()
	if !strings.Contains(out, "[ERROR]") {
		t.Errorf("expected [ERROR] in output, got: %s", out)
	}
	if !strings.Contains(out, "[Proposals]") {
		t.Errorf("expected [Proposals] in output, got: %s", out)
	}
}

func TestLogger_Warn(t *testing.T) {
	var buf bytes.Buffer
	l := New("Sync", &buf)
	l.Warn("retrying")
	out := buf.String()
	if !strings.Contains(out, "[WARN]") {
		t.Errorf("expected [WARN] in output, got: %s", out)
	}
}

func TestLogger_Debug_Disabled(t *testing.T) {
	var buf bytes.Buffer
	l := New("Test", &buf)
	l.Debug("should not appear")
	if buf.Len() != 0 {
		t.Errorf("expected no output for debug when disabled, got: %s", buf.String())
	}
}

func TestLogger_Debug_Enabled(t *testing.T) {
	var buf bytes.Buffer
	l := New("Test", &buf)
	l.SetDebug(true)
	l.Debug("visible")
	if !strings.Contains(buf.String(), "[DEBUG]") {
		t.Errorf("expected [DEBUG] in output, got: %s", buf.String())
	}
}
