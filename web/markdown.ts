import { Marked } from "marked";
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const markdown = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escape(text);
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!/^https?:\/\//i.test(href)) return label;
      return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
    image({ text }) {
      return escape(text);
    },
  },
});
export const renderMarkdown = (text: string) =>
  markdown.parse(text, { async: false });
