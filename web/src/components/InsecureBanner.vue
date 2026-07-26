<script setup lang="ts">
import AppIcon from "./AppIcon.vue";

/**
 * Permanent, undismissable. INSECURE_ALLOW_PUBLIC_ACCESS disables
 * authentication entirely, so the banner is not a notification that can be
 * cleared - it is a property of how this instance is running.
 */
</script>

<template>
  <div class="insecure-banner" role="alert" aria-live="assertive">
    <AppIcon name="alert" :size="20" />
    <p>
      <strong>INSECURE MODE: authentication is disabled.</strong>
      This instance trusts all local traffic.
    </p>
  </div>
</template>

<style scoped>
.insecure-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  padding: 0.6rem 1rem;
  background: #6e2e2c;
  color: #ffe9e8;
  border-bottom: 2px solid #e5605c;
  font-size: 0.9rem;
  text-align: center;
}

.insecure-banner p {
  margin: 0;
}

.insecure-banner strong {
  letter-spacing: 0.02em;
}
</style>
