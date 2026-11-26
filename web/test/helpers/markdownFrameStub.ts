import { defineComponent, h } from "vue";

/**
 * Stands in for the real MarkdownFrame in the browser tests, which only care
 * about what the browser hands it and what it does with `navigate`.
 */
export const MarkdownFrameStub = defineComponent({
  name: "MarkdownFrame",
  props: {
    source: { type: String, required: true },
    repoId: { type: Number, required: true },
    commit: { type: String, required: true },
    filePath: { type: String, required: true },
  },
  emits: ["navigate"],
  setup(props) {
    return () => h("div", { class: "markdown-frame-stub" }, props.source);
  },
});
