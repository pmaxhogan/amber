<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Textarea from "primevue/textarea";
import type { ImportCommitResponse, ImportPreviewResponse } from "@amber/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { pluralize } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import AppIcon from "../components/AppIcon.vue";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";

const api = useApi();
const router = useRouter();
const toast = useToaster();

const text = ref("");
const preview = ref<ImportPreviewResponse | null>(null);
const committed = ref<ImportCommitResponse | null>(null);
const previewing = ref(false);
const importing = ref(false);
const error = ref<ApiClientError | null>(null);

const PLACEHOLDER = [
  "https://github.com/nodejs/node",
  "github.com/vuejs/core",
  "pmaxhogan@github.com/pmaxhogan/mkvid",
  "# lines starting with a hash are ignored",
].join("\n");

const lineCount = computed(
  () =>
    text.value.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
      .length,
);

const canPreview = computed(() => text.value.trim() !== "" && !previewing.value);
const importableCount = computed(
  () => (preview.value?.summary.ok ?? 0) + (preview.value?.summary.warning ?? 0),
);

const STATUS_LABEL: Record<string, string> = {
  ok: "Ready",
  warning: "Warning",
  error: "Error",
};

const ACTION_LABEL: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  failed: "Failed",
};

async function runPreview(): Promise<void> {
  previewing.value = true;
  committed.value = null;
  error.value = null;
  try {
    preview.value = await api.previewImport(text.value);
  } catch (cause) {
    error.value = normalizeError(cause);
    preview.value = null;
  } finally {
    previewing.value = false;
  }
}

async function runImport(): Promise<void> {
  importing.value = true;
  error.value = null;
  try {
    const result = await api.commitImport(text.value);
    committed.value = result;
    preview.value = null;
    if (result.failed > 0) {
      toast.warn(
        `Imported ${result.created + result.updated}, ${result.failed} failed`,
        "Check the results table for the lines that did not import.",
      );
    } else {
      toast.success(
        `Imported ${pluralize(result.created + result.updated, "repository", "repositories")}`,
        "Amber staggers the first syncs over the next few minutes.",
      );
    }
  } catch (cause) {
    error.value = normalizeError(cause);
  } finally {
    importing.value = false;
  }
}

function reset(): void {
  preview.value = null;
  committed.value = null;
  error.value = null;
}

function parsedTarget(row: { parsed?: { host: string; path: string; port: number | null } }) {
  if (row.parsed === undefined) return "-";
  const port = row.parsed.port === null ? "" : `:${row.parsed.port}`;
  return `${row.parsed.host}${port}/${row.parsed.path}`;
}

function statusIcon(status: string): string {
  return status === "ok" ? "check" : "alert";
}
</script>

<template>
  <section>
    <PageHeader
      title="Import"
      description="Paste one repository URL per line. Amber parses every line before anything is written, so you can see exactly what it will do."
    />

    <div class="import-grid">
      <div class="amber-field">
        <label for="import-text">Repository URLs</label>
        <Textarea
          id="import-text"
          v-model="text"
          rows="12"
          :placeholder="PLACEHOLDER"
          spellcheck="false"
          autocomplete="off"
          class="import-textarea mono"
          @input="reset"
        />
        <p class="amber-note">
          {{ pluralize(lineCount, "line", "lines") }} to parse. Blank lines and lines starting with
          a hash are ignored. A "user@" prefix picks an existing account on that forge as the
          override; it never creates an account. SSH remotes are not supported.
        </p>
      </div>

      <div class="import-actions">
        <Button label="Preview" :loading="previewing" :disabled="!canPreview" @click="runPreview" />
        <Button
          v-if="preview"
          :label="`Import ${importableCount}`"
          :loading="importing"
          :disabled="importableCount === 0"
          @click="runImport"
        />
      </div>
    </div>

    <ErrorState :error="error" title="The import request failed" @retry="runPreview" />

    <section v-if="preview" class="import-results" data-testid="import-preview">
      <h2>Preview</h2>
      <p class="import-summary">
        <span class="chip chip--ok">{{ preview.summary.ok }} ready</span>
        <span class="chip chip--warning">{{ preview.summary.warning }} with warnings</span>
        <span class="chip chip--error">{{ preview.summary.error }} rejected</span>
      </p>
      <DataTable
        :value="preview.results"
        size="small"
        data-key="lineNumber"
        :row-class="(row: { status: string }) => `import-row import-row--${row.status}`"
      >
        <template #empty>
          <p class="amber-muted">Nothing to parse yet.</p>
        </template>
        <Column header="#" style="width: 3.5rem">
          <template #body="{ data }">{{ data.lineNumber }}</template>
        </Column>
        <Column header="Status" style="width: 8rem">
          <template #body="{ data }">
            <span class="status" :class="`status--${data.status}`">
              <AppIcon :name="statusIcon(data.status)" :size="14" />
              {{ STATUS_LABEL[data.status] ?? data.status }}
            </span>
          </template>
        </Column>
        <Column header="Protocol">
          <template #body="{ data }">
            <span class="mono">{{ data.parsed?.protocol ?? "-" }}</span>
          </template>
        </Column>
        <Column header="Target">
          <template #body="{ data }">
            <span class="mono">{{ parsedTarget(data) }}</span>
          </template>
        </Column>
        <Column header="Account override">
          <template #body="{ data }">
            <span v-if="data.parsed?.username" class="mono">{{ data.parsed.username }}</span>
            <span v-else class="amber-muted">forge default</span>
          </template>
        </Column>
        <Column header="Notes">
          <template #body="{ data }">
            <span v-if="data.message">{{ data.message }}</span>
            <span v-else class="amber-muted">-</span>
          </template>
        </Column>
      </DataTable>
    </section>

    <section v-if="committed" class="import-results" data-testid="import-results">
      <h2>Import results</h2>
      <p class="import-summary">
        <span class="chip chip--ok">{{ committed.created }} created</span>
        <span class="chip chip--warning">{{ committed.updated }} updated</span>
        <span class="chip chip--error">{{ committed.failed }} failed</span>
      </p>
      <DataTable
        :value="committed.results"
        size="small"
        data-key="lineNumber"
        :row-class="(row: { action: string }) => `import-row import-row--${row.action}`"
      >
        <Column header="#" style="width: 3.5rem">
          <template #body="{ data }">{{ data.lineNumber }}</template>
        </Column>
        <Column header="Result" style="width: 8rem">
          <template #body="{ data }">{{ ACTION_LABEL[data.action] ?? data.action }}</template>
        </Column>
        <Column header="Target">
          <template #body="{ data }">
            <span class="mono">{{ parsedTarget(data) }}</span>
          </template>
        </Column>
        <Column header="Notes">
          <template #body="{ data }">
            <span v-if="data.message">{{ data.message }}</span>
            <span v-else class="amber-muted">-</span>
          </template>
        </Column>
      </DataTable>
      <div class="import-actions">
        <Button label="Go to Repos" @click="router.push('/')" />
      </div>
    </section>
  </section>
</template>

<style scoped>
.import-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-width: 60rem;
}

.import-textarea {
  width: 100%;
  font-size: 0.85rem;
}

.import-actions {
  display: flex;
  gap: 0.6rem;
  margin-top: 0.5rem;
}

.import-results {
  margin-top: 2rem;
}

.import-results h2 {
  margin: 0 0 0.5rem;
  font-size: 1.05rem;
}

.import-summary {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin: 0 0 0.75rem;
}

.chip {
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  font-size: 0.8rem;
  border: 1px solid var(--p-content-border-color);
}

.chip--ok {
  color: var(--amber-success);
  background: var(--amber-success-bg);
}

.chip--warning {
  color: var(--amber-warn);
  background: var(--amber-warn-bg);
}

.chip--error {
  color: var(--amber-error);
  background: var(--amber-error-bg);
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.85rem;
}

.status--ok {
  color: var(--amber-success);
}

.status--warning {
  color: var(--amber-warn);
}

.status--error {
  color: var(--amber-error);
}

:deep(.import-row--warning),
:deep(.import-row--updated) {
  background: var(--amber-warn-bg);
}

:deep(.import-row--error),
:deep(.import-row--failed) {
  background: var(--amber-error-bg);
}
</style>
