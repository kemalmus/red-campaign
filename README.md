# NETLINK — Time of the Red

A static table for a solo [Cyberpunk RED](https://rtalsoriangames.com/cyberpunk/) campaign. It runs on GitHub Pages in Safari (iPhone and Mac). There is no server in the browser path for receiving narration: the page listens on a public [ntfy.sh](https://ntfy.sh) topic. Moves are published to that same topic; a small outbound relay on the operator's box forwards them to the GM bot (the official webhook does not allow browser CORS).

## What’s in this repo

Static HTML, CSS, and JS only. The narrator is [Kale TTS 1 Nano](https://huggingface.co/KaleComputer/kale-tts-1-nano) (Apache-2.0), loaded in the browser with `onnxruntime-web` (WASM, ~15 MB). Model weights are fetched from Hugging Face, not stored here. The webhook sender key is **not** in this repository and must never be committed.

The ntfy topic name lives in `config.js`. Treat the Pages URL as private-ish: anyone who knows the topic can post to the channel.

## Use

1. Open the Pages site.
2. Tap **Enter Night City** once (required on iOS to unlock audio; this also starts the voice download).
3. Type a move and send. Wait for the GM’s narration; it should play on its own.

Voice is AI-generated. English only.

## License

Page code in this repo may be used with the campaign. Kale TTS and its frontend are Apache-2.0, © Kale Computer / the upstream authors.
