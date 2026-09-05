import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getTypeDefinitions, getTypeDefinition, type TypeDefinition } from 'src/lib/api/client';

export const useTypesStore = defineStore('types', () => {
  const definitions = ref<Map<string, TypeDefinition>>(new Map());
  const loaded = ref(false);
  const loading = ref(false);

  async function loadDefinitions(): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    try {
      const defs = await getTypeDefinitions();
      const map = new Map<string, TypeDefinition>();
      for (const def of defs) {
        map.set(def.name, def);
      }
      definitions.value = map;
      loaded.value = true;
      console.log(`[TypesStore] Loaded ${map.size} type definitions`);
    } catch (err) {
      console.warn('[TypesStore] Failed to load type definitions:', err);
    } finally {
      loading.value = false;
    }
  }

  function getDefinition(name: string): TypeDefinition | undefined {
    return definitions.value.get(name);
  }

  function getFieldsForLayout(name: string, layout: string): string[] {
    const def = definitions.value.get(name);
    if (!def?.layouts?.[layout]) return [];
    return def.layouts[layout].fields;
  }

  /**
   * Custom (admin-added) field names for a type: schema fields that are neither
   * `core` (structural fields the backend depends on) nor already rendered by a
   * surface's built-in UI (passed as `builtin`). Ordered by the type's `form`
   * layout when present, else by field declaration order. This is how bespoke
   * profile/notice/proposal forms surface org-added custom fields without
   * double-rendering their own built-in ones.
   */
  function customFieldNames(name: string, builtin: Iterable<string> = []): string[] {
    const def = definitions.value.get(name);
    if (!def) return [];
    const handled = new Set(builtin);
    const order = def.layouts?.form?.fields;
    const names = order && order.length > 0
      ? order.filter((n) => def.fields.some((f) => f.name === n))
      : def.fields.map((f) => f.name);
    // Preserve layout order but drop dupes, core fields, and built-in names.
    const seen = new Set<string>();
    return names.filter((n) => {
      if (seen.has(n) || handled.has(n)) return false;
      seen.add(n);
      const f = def.fields.find((fd) => fd.name === n);
      return !!f && !f.core;
    });
  }

  /** Field names the type marks filterable via uiHints.filterable. */
  function filterableFieldNames(name: string): string[] {
    const def = definitions.value.get(name);
    if (!def) return [];
    return def.fields.filter((f) => f.uiHints?.filterable).map((f) => f.name);
  }

  return {
    definitions,
    loaded,
    loading,
    loadDefinitions,
    getDefinition,
    getFieldsForLayout,
    customFieldNames,
    filterableFieldNames,
  };
});
