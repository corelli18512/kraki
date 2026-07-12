# Kraki HTML Report Generation Prompt

Use the attached `kraki-html-report-template.html` to generate a technical report.

The template is primarily a visual and interaction template, not a fixed report form. Preserve its overall design language, responsive layout, card styles, semantic color system, SVG diagram containers, pan/zoom interactions, and print styles. Decide the report structure, number of sections, visualization types, and narrative flow freely based on the material.

Write the generated report in the language currently used in this Kraki session. The template and this prompt are intentionally written in English, but the final report content must follow the session language.

## Task

Topic:
{{TOPIC}}

Supporting material:
{{MATERIAL}}

## Generation requirements

- Modify the attached HTML template; do not redesign the page from scratch.
- Keep only the sections and components that help explain this report.
- Do not force the use of an executive summary, state machine, pipeline, ER diagram, decision matrix, timeline, or any other component.
- Choose visualizations freely based on the material, such as architecture diagrams, flows, sequence diagrams, state machines, data pipelines, timelines, comparison tables, or other clear SVG visualizations.
- Put complex diagrams inside the template's `data-panzoom`, `diagram-shell`, `diagram-viewport`, and `diagram-canvas` structure so they support local zooming and panning.
- If using Mermaid as a source, convert it to inline SVG before producing the final document. Do not load the Mermaid runtime.
- Feel free to shape the layout and narrative around the subject, while keeping the result readable in a 420–760px vertical side panel.
- Wide tables, code blocks, or diagrams may scroll horizontally inside their own containers, but the page itself must not have horizontal overflow.
- Base the report on the provided material. Do not present uncertain information as fact; label assumptions or open questions when necessary.
- Do not use external CSS, JavaScript, fonts, images, CDNs, or network requests.
- Remove all unused placeholders. The final HTML must not contain `{{...}}` placeholders.
- Output only one complete HTML document starting with `<!doctype html>`. Do not output Markdown fences or explanatory text.

Focus on helping me quickly understand the subject, its important relationships, trade-offs, and conclusions. Do not mechanically follow a fixed section order.
