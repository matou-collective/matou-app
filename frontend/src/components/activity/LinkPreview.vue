<template>
  <div class="link-preview-list">
    <a
      v-for="(link, idx) in links"
      :key="idx"
      :href="link.url"
      target="_blank"
      rel="noopener noreferrer"
      class="link-card"
    >
      <ExternalLink :size="16" class="link-icon" />
      <div class="link-info">
        <span class="link-label">{{ link.label }}</span>
        <span class="link-url">{{ truncateUrl(link.url) }}</span>
      </div>
    </a>
  </div>
</template>

<script setup lang="ts">
import { ExternalLink } from 'lucide-vue-next';

defineProps<{ links: { label: string; url: string }[] }>();

function truncateUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 30 ? u.pathname.slice(0, 30) + '...' : u.pathname;
    return u.host + path;
  } catch {
    return url.length > 50 ? url.slice(0, 50) + '...' : url;
  }
}
</script>

<style scoped>
.link-preview-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.link-card {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 8px);
  text-decoration: none;
  transition: border-color 0.15s;
}

.link-card:hover {
  border-color: var(--matou-primary);
}

.link-icon {
  flex-shrink: 0;
  color: var(--matou-muted-foreground);
}

.link-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.link-label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--matou-foreground);
}

.link-url {
  font-size: 0.7rem;
  color: var(--matou-muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
