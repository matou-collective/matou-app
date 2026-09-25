# Preview harness

Click through the app in a browser, wearing any brand kit, with **no backend,
config server or KERIA running**. For brand-kit and copy work: see what a Coa
build looks like before building one.

```bash
cd frontend
npm run harness                    # kit "tui", http://127.0.0.1:9100
npm run harness -- --kit pale      # another harness kit
npm run harness -- --kit ../coa-kit --port 9200   # any kit directory
```

Stop it with Ctrl-C: the stock kit (`../coa-kit`) is re-applied on exit, so the
generated files go back to what git has.

## Scenarios

A pill in the bottom-left corner switches scenario (it reloads the page and
starts the scenario from its seed). Or open `?scenario=<id>` directly; add
`&reset` to start over.

| id | who | what you see |
|---|---|---|
| `registration` | nobody yet | Fresh install. Join Now → kit welcome → info pages → profile form (with the kit's custom questions) → identity → recovery phrase → verify → pending approval. |
| `pending` | Wiremu | Registered, waiting on the pending-approval screen. |
| `member` | Tama | Approved member: welcome overlay → dashboard with chat, notices and events. |
| `steward` | Aroha | Founding steward with two registrations waiting. |

Adding one = an entry in `SCENARIOS` (`scenarios.ts`).

The pill's **☾ Night / ☀ Day** button flips the app's own theme (the same
`.dark` class and `matou:theme` setting the dashboard's toggle uses), live, and
it survives reloads and scenario restarts.

## Platform

The pill's second dropdown (or `?platform=`) picks the shell the app believes
it runs in:

- **Desktop** (default): a stand-in for Electron's preload bridge, so you get
  the brand-coloured title bar and the splash's "Sign in with your phone". That
  flow is scripted: the QR shows, a phone "scans" it after ~6 s and shows code
  `042917`, and after ~12 s this computer is signed in as Tama.
- **Browser**: the plain SPA.

A phone shell needs Capacitor's native plugins and isn't modelled. The harness
always serves from `127.0.0.1` (a `localhost` URL redirects there), so the
desktop backend URL (`http://127.0.0.1:<port>`) and the browser one
(`…/__fake`) share an origin.

Every harness person has a real recovery phrase (hover the pill to see them).
"Recover identity" with one of them signs in as that person.

## Kits

`kits/<id>/kit.json` + logo, in the COA kit format (`src/kit/types.ts`):

| id | brand | features |
|---|---|---|
| `tui` | Tūī — deep green + teal, two info pages, two custom questions | all |
| `bright` | violet + cyan, the loudest pair | identity + chat only |
| `ngati-example` | maroon + gold (a saturated secondary) | all |
| `pale` | light blue on near-white — for finding text that disappears | chat, notices, events |
| `whakatohea-demo` | the demo community's kit | chat, notices, events |

Brand and features are baked in at build time (`src/generated/kit.ts`,
`kit-tokens.scss`, the `__KIT_*__` defines), so switching kit means restarting
the harness with another `--kit`. Edits to a kit's `kit.json` need a restart
too; edits to the app's own code hot-reload as usual.

## How it works

- `run.mjs` applies the kit (sources plus the browser-visible logo and
  favicons, not the ~40 platform icons) and runs `quasar dev` with
  `MATOU_HARNESS=1` and the backend and config-server URLs pointed at `/__fake`.
- `quasar.config.ts` adds, only under that flag, `backendPlugin.ts` (a Vite
  middleware answering the backend and config-server API from per-scenario data
  in `backendWorld.ts` / `backendRoutes.ts`) and the `boot.ts` boot file, which
  runs before `keri`.
- `boot.ts` seeds the scenario's storage and swaps the app's KERIClient
  singleton for `fakeKeria.ts`, a small in-browser wallet (AIDs and held
  credentials in localStorage). The real `keri` boot, router guard, stores and
  screens run unchanged.
- Writes land in the scenario's world and last until you restart it.
  Unmodelled routes answer like an empty backend (GET → 404, writes →
  `{ success: true }`) and are logged once as `[harness] unmodelled …` in the
  dev-server console. Unmodelled KERIA calls are logged in the browser console.
- `fixtures/types.json` is the Go type registry dumped once. Regenerate it
  after a type change with a throwaway `main` that prints
  `types.NewRegistry()` + `Bootstrap()` + `All()` as JSON.

Nothing here ships: without `MATOU_HARNESS=1` the plugin and the boot file are
not in the config.
