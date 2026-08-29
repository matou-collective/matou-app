package types

import (
	"strconv"
	"strings"
)

// MatchesFilters reports whether an object's data satisfies every filter in
// filters. Only fields marked filterable in the schema are honoured; a filter
// naming a non-filterable or unknown field is ignored (callers should reject
// those up front — see FilterableFieldNames). Matching is case-insensitive.
//
// For scalar (string/enum/number/boolean) fields the stored value must equal
// the filter value. For array fields the filter matches when any element of the
// array equals the filter value, so ?skills=go returns members who list "go".
func MatchesFilters(def *TypeDefinition, data map[string]interface{}, filters map[string]string) bool {
	for name, want := range filters {
		field, ok := def.Field(name)
		if !ok || field.UIHints == nil || !field.UIHints.Filterable {
			// Not a filterable field — do not constrain on it here.
			continue
		}
		val, exists := data[name]
		if !exists || val == nil {
			return false
		}
		if !valueMatches(val, want) {
			return false
		}
	}
	return true
}

// valueMatches reports whether a stored value equals want (case-insensitive),
// descending into arrays so any matching element counts.
func valueMatches(val interface{}, want string) bool {
	switch v := val.(type) {
	case []interface{}:
		for _, item := range v {
			if valueMatches(item, want) {
				return true
			}
		}
		return false
	case string:
		return strings.EqualFold(v, want)
	case bool:
		return strings.EqualFold(boolString(v), want)
	case float64:
		return strings.EqualFold(numberString(v), want)
	default:
		return false
	}
}

func boolString(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func numberString(f float64) string {
	// Render integers without a trailing ".000000" so ?version=1 matches 1.
	if f == float64(int64(f)) {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}
