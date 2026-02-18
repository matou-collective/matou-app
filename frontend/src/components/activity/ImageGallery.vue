<template>
  <div class="image-gallery" :class="{ 'single': images.length === 1, 'grid': images.length >= 2 }">
    <img
      v-for="(img, idx) in images"
      :key="idx"
      :src="getFileUrl(img)"
      :alt="`Image ${idx + 1}`"
      class="gallery-image"
      loading="lazy"
    />
  </div>
</template>

<script setup lang="ts">
import { getFileUrl } from 'src/lib/api/client';

defineProps<{ images: string[] }>();
</script>

<style scoped>
.image-gallery.single {
  display: block;
}

.image-gallery.single .gallery-image {
  width: 100%;
  max-height: 400px;
  object-fit: cover;
  border-radius: var(--matou-radius, 8px);
}

.image-gallery.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}

.image-gallery.grid .gallery-image {
  width: 100%;
  height: 200px;
  object-fit: cover;
  border-radius: var(--matou-radius, 8px);
}
</style>
