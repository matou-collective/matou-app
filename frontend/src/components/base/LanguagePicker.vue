<template>
  <div class="language-picker" :class="{ open }">
    <button
      type="button"
      class="language-picker__trigger"
      :aria-label="t('language.selectLanguage')"
      :title="t('language.selectLanguage')"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="open = !open"
    >
      <Languages class="language-picker__icon" />
      <span class="language-picker__current">{{ currentMeta?.nativeName }}</span>
      <ChevronDown class="language-picker__chevron" />
    </button>

    <!-- Click-away backdrop + popup list -->
    <template v-if="open">
      <div class="language-picker__backdrop" @click="open = false" />
      <ul class="language-picker__menu" role="listbox">
        <li v-for="l in locales" :key="l.code" role="option" :aria-selected="l.code === locale">
          <button
            type="button"
            class="language-picker__option"
            :class="{ active: l.code === locale }"
            @click="choose(l.code)"
          >
            <span class="language-picker__name">{{ l.nativeName }}</span>
            <span
              v-if="l.draft"
              class="language-picker__draft"
              :title="t('language.draftTooltip')"
            >{{ t('language.draftLabel') }}</span>
            <Check v-if="l.code === locale" class="language-picker__check" />
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Languages, ChevronDown, Check } from 'lucide-vue-next';
import { useLocale } from 'src/composables/useLocale';
import { localeMeta } from 'src/i18n/config';

const { t } = useI18n();
const { locale, locales, setLocale } = useLocale();

const open = ref(false);
const currentMeta = computed(() => localeMeta(locale.value));

function choose(code: string): void {
  setLocale(code);
  open.value = false;
}
</script>

<style lang="scss" scoped>
.language-picker {
  position: relative;
  display: inline-block;
}

.language-picker__trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.6rem;
  background: transparent;
  border: 1px solid var(--matou-border, rgba(255, 255, 255, 0.3));
  border-radius: 8px;
  color: inherit;
  cursor: pointer;
  font-size: 0.85rem;
  line-height: 1;
  transition: background 0.15s ease;

  &:hover {
    background: rgba(127, 127, 127, 0.12);
  }
}

.language-picker__icon {
  width: 16px;
  height: 16px;
}

.language-picker__chevron {
  width: 14px;
  height: 14px;
  opacity: 0.7;
}

.language-picker__backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
}

.language-picker__menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 101;
  min-width: 11rem;
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  background: var(--matou-popover, #ffffff);
  color: var(--matou-popover-foreground, #1a1a1a);
  border: 1px solid var(--matou-border, rgba(0, 0, 0, 0.1));
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.language-picker__option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 0.625rem;
  background: transparent;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  font-size: 0.9rem;
  color: inherit;

  &:hover {
    background: rgba(127, 127, 127, 0.12);
  }

  &.active {
    font-weight: 600;
  }
}

.language-picker__name {
  flex: 1 1 auto;
}

.language-picker__draft {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
  padding: 0.05rem 0.3rem;
  border: 1px solid currentColor;
  border-radius: 6px;
}

.language-picker__check {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
</style>
