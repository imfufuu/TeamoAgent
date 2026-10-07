# Local moderation models

Vendored for browser-local moderation. The only remote call is the optional grey-zone second opinion (vision model via the user's own gateway key, see `js/moderation.js` REMOTE_IMAGE_REVIEW_MODEL); it runs only when both local models are unsure and can be switched off in Settings.

- Text: TensorFlow.js Toxicity classifier (`@tensorflow-models/toxicity` 1.2.2) plus Universal Sentence Encoder Lite tokenizer/model, Apache-2.0. Runtimes in `assets/vendor/toxicity.local.min.js` and `assets/vendor/use.min.js` load from `assets/moderation/text-*`.
- Image: NudeNet 320n ONNX detector from `notAI-tech/nudenet` (quantized locally, native 320px inference; explicit body-part detection) plus NSFWJS **InceptionV3** classifier from `infinitered/nsfwjs` (`models/inception_v3`, Keras layers format, uint8-quantized, 22.6 MB, 299px input; replaced MobileNetV2-mid on 2026-10-07 for much better recall on real-photo nudity). Both are vendored for local static inference.

Current policy blocks adult sexual content, exploitative/minor sexual content, drug/firearm crime, mass-harm, and public-morals/taboo sexual content. Images are blocked when NudeNet finds an exposed body part, when NSFWJS porn/hentai ≥ 0.5 or porn+hentai+sexy ≥ 0.7, or when the grey-zone remote review returns `unsafe` (refusals count as unsafe).
