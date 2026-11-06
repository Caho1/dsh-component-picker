# dsh-component-picker

Claude-style element picker for the **built-in Browser tab** of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Open a page in the right-sidebar Browser, click the pointer tool in its toolbar,
hover any element to see it outlined, click it — and the element's identity,
React component, props, source file and a screenshot travel with your next
message. The chat input stays clean: a compact pill appears in the composer, the
serialized element context is delivered to the model by the Host half, and the
transcript shows a collapsed disclosure row instead of a wall of markup.

```
composer:   ▸ <AuthGate />                         ← pill, inside the composer card
transcript: ▷ <AuthGate /> ▸                       ← collapsed context row
            (click) 元素 / 组件 / 来源 / 选择器 / Props / payload
```

## Install

The bundle is a plain dsh plugin package (no build step). Install it into a
profile with the Plugin Manager's `install_bundle`, pointing at this directory:

```js
// agent tool call
plugin_manager({ action: 'install_bundle', target: '/absolute/path/to/dsh-component-picker' })
```

or copy this directory into the profile and add the bundle by name. The package
declares `dsh.bundle.patch` (`cordis.patch.yml`) and `dsh.client` (a Web client
half), so the Host row, the browser tool, the composer pill and the chat row all
activate together.

After installing, reload the Harness window once so the client half boots.

## Use

1. Open a page in the right-sidebar **Browser** tab.
2. Click the pointer icon at the right end of the Browser toolbar.
3. Hover: the element under the cursor is outlined in orange with a
   `tag#id.class` label. The mouse pointer stays the page's own cursor.
4. Click to pick. **Esc** or right-click cancels; the picked element keeps its
   outline for 4 seconds.
5. A pill appears inside the composer above the text. Hover it for the detail
   card (screenshot, element, component, props, source, text, selector, styles,
   HTML), click to pin it, `×` to drop it.
6. Send. The element context reaches the model without polluting your text.

## How it works

| Piece | Implementation |
| --- | --- |
| Toolbar tool | Appended to the Browser tab's own `<form class="…toolbar">` (the Browser package exposes no toolbar slot), re-seated by a MutationObserver + 1s sweep |
| Page inspector | `webview.executeJavaScript` runs a self-contained script in the guest page: closed shadow root, `z-index: 2147483647`, `pointer-events: none`, orange `#ec835a` / `#d95926` palette, 180ms geometry easing |
| Capture | tag, id, classes, attributes, text ≤200, selector ≤4 levels, 13 computed styles, outerHTML ≤1200, React fiber component + owners + summarised props, `_debugSource` |
| Screenshot | `webview.capturePage(crop)` (80px padding, longest edge ≤1200) drawn with an orange outline, shown in the detail card only |
| Composer pill | `div[data-dsh-cp-rail]` injected as the composer card's first child, aligned to the text column; 40px / 4px radius / double hairline per the shipped spec |
| Detail card | `shell.overlay` fixed layer, `top-start` with flip, 600ms hover intent, 200ms grace, warm latch, click to pin |
| Delivery | Host route `POST /component-picker/stage` → `agent.send(message, 'next-turn', false)`; falls back to prefixing the prompt when no Host route answers |
| Chat row | `conversation.chat.node` renderers for `context` and `turn-trigger`, so the injected context renders as a pointer row rather than raw markup |

Client and Host halves talk over an exact HTTP route on `ctx.webServer` because
installed bundle client halves get no `harness` RPC bridge — the module loader
calls `factory(require)` only.

The context is serialized as one compact line, so even the fallback path stays
readable:

```xml
<selected-element component=AuthGate tag=div class="flex size-14" owners="Page"
 text="…" selector="body > main > section > div" source=/src/auth/gate.tsx:12
 props='{"scenario":"coding-scenario"}' />
```

## Requirements and known gaps

- Desktop only: the tab must be an Electron `<webview>`
  (`[data-sidebar-browser-frame="webview"]`). Web profiles use an iframe with no
  scriptable handle.
- Component names come from React fibers; `_debugSource` exists in development
  builds. There is no sourcemap VLQ resolution, so production bundles report the
  bundle location or nothing.
- Replacing the `turn-trigger` node kind means other wake-up rows (schedules,
  notifications) lose their specialized copy and fall back to a generic
  title + expandable body.
- Screenshots live only in the detail card; they are not sent to the model.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: HTTP routes (`state`, `stage`) and `agent.inject` delivery |
| `client.js` | Web client half: toolbar tool, page inspector, composer pill, detail card, chat rows |
| `cordis.patch.yml` | Bundle patch inserting the Host row |
| `locale/*.json` | Plugin Manager title/description (en, zh) |
| `icon.svg` | Plugin artwork |

## License

MIT
