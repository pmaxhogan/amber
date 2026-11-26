<script setup lang="ts">
/**
 * Renders markdown that came out of a repository, which is hostile input.
 *
 * The seam the browser builds against:
 * - `source` is the markdown text.
 * - `repoId`, `commit` (a full commit oid) and `filePath` (the markdown file's
 *   own path in the tree) say where relative links and images resolve from.
 * - `navigate` fires when a link points at another path in the same tree. The
 *   path is normalized and relative to the root of the tree; the listener
 *   decides whether it is a file or a directory.
 */
import { BROWSE_OID_PATTERN } from "@amber/shared";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useApi } from "../api/provide.ts";
import {
  MarkdownBudgetError,
  buildFrameDocument,
  displayText,
  externalHref,
  frameImageSource,
  mountMarkdownFrame,
  readFrameTheme,
  renderMarkdown,
  type MountedFrame,
  type RenderedLink,
} from "../lib/markdown/index.ts";
import { useThemeStore } from "../stores/theme.ts";

const props = defineProps<{
  source: string;
  repoId: number;
  commit: string;
  filePath: string;
}>();

const emit = defineEmits<{
  navigate: [path: string];
}>();

const api = useApi();
const theme = useThemeStore();
const host = ref<HTMLDivElement | null>(null);
const failed = ref(false);
/** The file was over a work limit rather than unsafe. */
const tooComplex = ref(false);
/** Whether this browser delivers clicks in the frame to our listeners. */
const clicksHandled = ref(true);
const links = shallowRef<RenderedLink[]>([]);
let mounted: MountedFrame | null = null;

const MAX_LISTED_LINKS = 200;

/**
 * Where clicks inside the frame never reach the parent (WebKit, with no
 * `allow-scripts`), the links are offered here instead, as text the app
 * renders itself. External hrefs are checked once more on the way out.
 */
interface ListedLink {
  key: number;
  text: string;
  path: string | null;
  href: string | null;
  /** Where an external link goes, shown next to its text. */
  destination: string | null;
}

/**
 * The host of an http(s) link (the URL parser gives it in ASCII, so an
 * internationalized look-alike shows as `xn--...`), or the address of a
 * mailto link.
 */
function destinationOf(href: string): string {
  const url = new URL(href);
  return url.protocol === "mailto:" ? displayText(decodeMailto(url.pathname)) : url.host;
}

function decodeMailto(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

const listedLinks = computed<ListedLink[]>(() =>
  links.value.slice(0, MAX_LISTED_LINKS).flatMap((link, index): ListedLink[] => {
    if (link.target.kind === "tree") {
      const text = displayText(link.text);
      return [{ key: index, text, path: link.target.path, href: null, destination: null }];
    }
    const href = externalHref(link.target.href);
    if (href === null) return [];
    const text = displayText(link.text);
    return [{ key: index, text, path: null, href, destination: destinationOf(href) }];
  }),
);

function teardown(): void {
  mounted?.dispose();
  mounted = null;
}

/**
 * Renders into a fresh sandboxed frame. Any failure, anywhere, shows the
 * source as plain text instead: never partially sanitized HTML.
 */
function render(): void {
  teardown();
  const container = host.value;
  if (container === null) return;
  try {
    if (!BROWSE_OID_PATTERN.test(props.commit)) throw new Error("commit is not a full object id");
    const origin = window.location.origin;
    const imageSource = frameImageSource(origin, props.repoId);
    const rendered = renderMarkdown(props.source, {
      filePath: props.filePath,
      imageSource,
      imageUrl: (path) =>
        new URL(api.browseRawUrl(props.repoId, props.commit, path, true), origin).href,
    });
    const frameTheme = readFrameTheme(container, theme.dark);
    const documentHtml = buildFrameDocument({
      bodyHtml: rendered.bodyHtml,
      expectedElements: rendered.elementCount,
      origin,
      repoId: props.repoId,
      theme: frameTheme,
    });
    failed.value = false;
    tooComplex.value = false;
    links.value = rendered.links;
    mounted = mountMarkdownFrame(container, documentHtml, {
      title: `Rendered ${props.filePath}`,
      colorScheme: frameTheme.dark ? "dark" : "light",
      onNavigate: (path) => emit("navigate", path),
      onClickHandling: (handled) => {
        clicksHandled.value = handled;
      },
      onUnexpectedLocation: () => {
        teardown();
        failed.value = true;
      },
    });
  } catch (cause) {
    teardown();
    links.value = [];
    failed.value = true;
    tooComplex.value = cause instanceof MarkdownBudgetError;
    if (import.meta.env.DEV) console.warn("markdown render failed", cause);
  }
}

onMounted(render);
watch(() => [props.source, props.repoId, props.commit, props.filePath, theme.dark], render, {
  flush: "post",
});
onBeforeUnmount(teardown);
</script>

<template>
  <div class="markdown-frame">
    <div v-if="failed" class="markdown-frame-fallback">
      <p v-if="tooComplex" class="markdown-frame-note">
        This file is too large or too complex to render here, so its source is shown as plain text.
      </p>
      <p v-else class="markdown-frame-note">
        This file could not be rendered safely, so its source is shown as plain text.
      </p>
      <pre class="markdown-frame-source mono">{{ source }}</pre>
    </div>
    <div v-show="!failed" ref="host" class="markdown-frame-host"></div>
    <details
      v-if="!failed && !clicksHandled && listedLinks.length > 0"
      class="markdown-frame-links"
    >
      <summary>Links in this file ({{ listedLinks.length }})</summary>
      <p class="markdown-frame-note">
        This browser does not pass clicks inside the preview to the app, so the links are listed
        here.
      </p>
      <ul>
        <li v-for="link in listedLinks" :key="link.key">
          <button
            v-if="link.path !== null"
            type="button"
            class="markdown-frame-link-button"
            @click="emit('navigate', link.path)"
          >
            {{ link.text }}
          </button>
          <a
            v-else
            :href="link.href ?? undefined"
            target="_blank"
            rel="noopener noreferrer nofollow"
          >
            {{ link.text }}
          </a>
          <span v-if="link.destination !== null" class="markdown-frame-link-host">
            ({{ link.destination }})
          </span>
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.markdown-frame-note {
  margin: 0 0 0.5rem;
  color: var(--p-text-muted-color);
  font-size: 0.875rem;
}

.markdown-frame-links {
  margin-top: 0.75rem;
  font-size: 0.875rem;
}

.markdown-frame-links summary {
  cursor: pointer;
}

.markdown-frame-links ul {
  margin: 0;
  padding-left: 1.25rem;
  overflow-wrap: anywhere;
}

.markdown-frame-link-host {
  margin-left: 0.25rem;
  color: var(--p-text-muted-color);
  overflow-wrap: anywhere;
}

.markdown-frame-link-button {
  padding: 0;
  border: 0;
  background: none;
  color: var(--p-primary-color);
  font: inherit;
  text-align: left;
  text-decoration: underline;
  cursor: pointer;
}

/* No wrapping: WebKit takes tens of seconds to wrap preformatted text with
   mixed-direction runs (50 KB of alternating Hebrew and Latin), and this view
   is what an over-budget file falls back to. Long lines scroll instead. */
.markdown-frame-source {
  margin: 0;
  padding: 0.75rem;
  overflow-x: auto;
  white-space: pre;
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  font-size: 0.8125rem;
}
</style>
