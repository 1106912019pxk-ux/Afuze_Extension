# Afuze Extension

A small collection of experiments for feeding external media streams into Afuze/zFuse.

## Douyu live stream probe

`douyu.mjs` is the first minimal test. It converts a Douyu room id into the current direct FLV stream URL so it can be pasted into Afuze's live-stream feature.

### Design goals

- no Loon
- no VPS
- no Docker
- no npm packages
- no Douyu login cookie
- only Node.js 20+ is required

The script requests Douyu's current H5 signing code, evaluates it inside a restricted Node `vm` context, calls `getH5Play`, and prints the resulting direct FLV URL.

### Quick test: 玩机器 6657

```bash
node douyu.mjs 6657 --check
```

If successful, the end of the output looks like:

```text
Status: LIVE
Format: FLV
Direct check: OK (..., FLV header OK)

Afuze stream URL:
https://...flv?...
```

Copy the complete URL after `Afuze stream URL:` into Afuze's live-stream input.

### Other rooms

```bash
node douyu.mjs ROOM_ID
```

For example:

```bash
node douyu.mjs 93589 --check
```

If the anchor is offline, the script exits without producing a fake stream URL.

### Options

```text
--check      Open the returned CDN URL briefly and verify it works without a Douyu Referer.
--rate=N     Override the requested Douyu rate. Default: -1.
--no-url     Do not print the signed stream URL (used by CI smoke tests).
-h, --help   Show help.
```

### Why `--check` matters for Afuze

Afuze normally receives only a media URL; it does not necessarily send a custom Douyu `Referer`. The check deliberately opens the returned CDN URL without a Douyu Referer and verifies the FLV header. If this succeeds, it is a much stronger indication that the URL can be handed directly to Afuze.

### Limitations

- The returned FLV URL is signed and temporary. Re-run the script when it expires.
- This is intentionally only a Douyu proof of concept, not a general live-platform framework.
- Douyu can change its private web APIs/signing logic at any time.
- This experiment requests normal public live playback only; it does not bypass account/region/paid-content permissions.

## Next step

Only after the direct Afuze test succeeds should this be simplified further, for example into an iPhone-friendly one-tap flow for a small fixed list of rooms.
