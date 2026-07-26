<script setup lang="ts">
import { computed } from "vue";
import type { ForgeKind } from "@amber/shared";
import AppIcon from "./AppIcon.vue";

/**
 * Forge-specific instructions for minting the credential amber needs.
 *
 * Every one of these asks for the narrowest scope that still allows a clone.
 * Amber only ever reads, so a token with write access is a liability with no
 * upside.
 */

const props = defineProps<{ kind: ForgeKind; origin?: string }>();

interface Help {
  title: string;
  linkLabel: string;
  href: string;
  steps: string[];
  note?: string;
}

const HELP: Record<ForgeKind, (origin: string) => Help> = {
  github: () => ({
    title: "GitHub fine-grained personal access token",
    linkLabel: "Create a fine-grained token on GitHub",
    href: "https://github.com/settings/personal-access-tokens/new",
    steps: [
      'Set the expiration to "No expiration" so backups do not stop silently.',
      "Under Repository access, pick as much as you want backed up: all repositories, or a selected list.",
      'Under Permissions, grant ONLY "Contents: Read-only". Nothing else.',
      "Paste the generated token into the secret field. Your GitHub username goes in the username field.",
    ],
    note: 'GitHub adds "Metadata: Read-only" automatically. That is expected and is the only other permission the token needs.',
  }),
  gitlab: () => ({
    title: "GitLab personal access token",
    linkLabel: "Create a token on GitLab",
    href: "https://gitlab.com/-/user_settings/personal_access_tokens",
    steps: [
      "Create a personal access token.",
      "Select the read_repository scope and nothing else.",
      "Leave the expiry as far out as your instance allows, or blank where that is permitted.",
      "Paste the token into the secret field with your GitLab username.",
    ],
  }),
  bitbucket: () => ({
    title: "Bitbucket app password or API token",
    linkLabel: "Create an app password on Bitbucket",
    href: "https://bitbucket.org/account/settings/app-passwords/",
    steps: [
      "Create an app password (or an API token on newer accounts).",
      "Grant Repositories: Read. Leave every other permission unchecked.",
      "Use your Bitbucket username, not your email address, in the username field.",
    ],
  }),
  gitea: (origin) => ({
    title: "Gitea access token",
    linkLabel: "Create a token in Gitea",
    href: `${origin === "" ? "https://gitea.example.com" : origin}/user/settings/applications`,
    steps: [
      "Open Settings, then Applications, then Generate New Token.",
      "Grant repository read access only.",
      "Paste the token into the secret field with your Gitea username.",
    ],
  }),
  generic: () => ({
    title: "HTTPS credentials",
    linkLabel: "",
    href: "",
    steps: [
      "Amber authenticates with HTTP basic auth over HTTPS, exactly as git does.",
      "Use a token or app password scoped to read-only repository access where the host offers one.",
      "Leave the secret blank for a host that serves repositories anonymously.",
    ],
  }),
};

const help = computed(() => HELP[props.kind](props.origin ?? ""));
</script>

<template>
  <aside class="credential-help">
    <h4>{{ help.title }}</h4>
    <ol>
      <li v-for="step in help.steps" :key="step">{{ step }}</li>
    </ol>
    <p v-if="help.note" class="credential-help__note">{{ help.note }}</p>
    <a v-if="help.href" :href="help.href" target="_blank" rel="noreferrer noopener">
      {{ help.linkLabel }}
      <AppIcon name="external" :size="13" />
    </a>
    <p class="credential-help__note">
      Amber stores the secret encrypted and never returns it. It is used only for fetches against
      this forge.
    </p>
  </aside>
</template>

<style scoped>
.credential-help {
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: 0.85rem 1rem;
  background: var(--p-content-background);
  font-size: 0.85rem;
}

.credential-help h4 {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
}

.credential-help ol {
  margin: 0;
  padding-left: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  color: var(--p-text-muted-color);
}

.credential-help__note {
  margin: 0.6rem 0 0;
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}

.credential-help a {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.6rem;
  color: var(--p-primary-color);
}
</style>
