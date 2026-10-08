# pondscape

A living pond for the web: physically based water and caustics, lily pads, koi and axolotls, rendered with WebGL2.

```sh
npm install pondscape
```

- **The library** is in [`packages/pondscape`](packages/pondscape), with full documentation in its [README](packages/pondscape/README.md).
- **The demo site** is in [`apps/site`](apps/site), a Next.js app.

## Development

```sh
npm install
npm run dev        # the demo at http://localhost:3000, using the library's source
npm run typecheck
npm run build -w pondscape
```

The demo takes options from the URL, e.g. `/?calm`, `/?fish=0&axolotls=5`.
