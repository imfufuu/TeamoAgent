# Local moderation models

Vendored for browser-local moderation; no TeamoRouter/DeepSeek call is made for moderation.

- Text: TensorFlow.js Toxicity classifier (`@tensorflow-models/toxicity` 1.2.2) plus Universal Sentence Encoder Lite tokenizer/model, Apache-2.0. Runtimes in `assets/vendor/toxicity.local.min.js` and `assets/vendor/use.min.js` load from `assets/moderation/text-*`.
- Image: NSFWJS MobileNetV2 Mid model from `infinitered/nsfwjs`, MIT.

Current policy blocks adult sexual content, exploitative/minor sexual content, drug/firearm crime, mass-harm, and public-morals/taboo sexual content. Image NSFW is blocked at the configured image threshold.
