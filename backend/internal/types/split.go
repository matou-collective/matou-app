package types

// RouteFieldsBySchema distributes caller-supplied field values across the given
// destination type definitions according to each type's declared fields. A
// (name, value) pair from inputs is placed into a destination type's result map
// iff that type's schema declares a field with that name; a field declared by
// several destination types is placed into each. Values whose field no
// destination type declares are dropped — the org removed that field from every
// relevant schema.
//
// Only non-core, caller-supplied fields belong in inputs. Core/computed fields a
// handler depends on structurally are pinned by the handler after routing, so an
// admin schema edit can never move them out of the space the handler expects
// (issue #300, part of #180). Because routing reads each type's Fields (and each
// type carries its own Space), moving a field between type schemas moves where a
// new object's value is stored.
//
// The result always contains an entry for every non-nil def (an empty map when
// the def declares none of the input fields), keyed by def.Name.
func RouteFieldsBySchema(inputs map[string]interface{}, defs ...*TypeDefinition) map[string]map[string]interface{} {
	out := make(map[string]map[string]interface{}, len(defs))
	for _, def := range defs {
		if def == nil {
			continue
		}
		dest := make(map[string]interface{})
		for name, val := range inputs {
			if _, ok := def.Field(name); ok {
				dest[name] = val
			}
		}
		out[def.Name] = dest
	}
	return out
}
