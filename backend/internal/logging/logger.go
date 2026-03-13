// backend/internal/logging/logger.go
package logging

import (
	"fmt"
	"io"
	"log"
	"os"
	"time"
)

// Logger provides structured logging with component tags and levels.
// All output goes to stderr so it is captured by Playwright's BackendManager.
type Logger struct {
	component string
	output    *log.Logger
	debug     bool
}

// New creates a logger for the given component. If w is nil, defaults to os.Stderr.
func New(component string, w ...io.Writer) *Logger {
	var out io.Writer = os.Stderr
	if len(w) > 0 && w[0] != nil {
		out = w[0]
	}
	return &Logger{
		component: component,
		output:    log.New(out, "", 0),
	}
}

// SetDebug enables or disables debug output.
func (l *Logger) SetDebug(enabled bool) {
	l.debug = enabled
}

func (l *Logger) log(level, format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	ts := time.Now().Format("2006-01-02T15:04:05.000")
	l.output.Printf("%s [%s] [%s] %s", ts, level, l.component, msg)
}

// Info logs an informational message.
func (l *Logger) Info(format string, args ...interface{}) {
	l.log("INFO", format, args...)
}

// Warn logs a warning message.
func (l *Logger) Warn(format string, args ...interface{}) {
	l.log("WARN", format, args...)
}

// Error logs an error message.
func (l *Logger) Error(format string, args ...interface{}) {
	l.log("ERROR", format, args...)
}

// Debug logs a debug message (only if debug is enabled).
func (l *Logger) Debug(format string, args ...interface{}) {
	if !l.debug {
		return
	}
	l.log("DEBUG", format, args...)
}
