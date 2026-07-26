<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router";
import logoUrl from "./assets/logo.svg";
import { NAV_LINKS } from "./router/index.ts";
</script>

<template>
  <div class="amber-shell">
    <header class="amber-header">
      <RouterLink to="/" class="amber-brand">
        <img :src="logoUrl" alt="" />
        <span>Amber</span>
      </RouterLink>
      <nav class="amber-nav">
        <RouterLink v-for="link in NAV_LINKS" :key="link.to" :to="link.to">
          {{ link.label }}
        </RouterLink>
      </nav>
    </header>
    <main class="amber-main">
      <RouterView />
    </main>
  </div>
</template>
