# Local moderation models

Vendored for browser-local moderation; no TeamoRouter/DeepSeek call is made for moderation.

- Text: TensorFlow.js Toxicity classifier (`@tensorflow-models/toxicity` 1.2.2) plus Universal Sentence Encoder tokenizer/model, Apache-2.0. Runtime in `assets/vendor/toxicity.local.min.js` is patched to load from `assets/moderation/text-*`.
- Image: NSFWJS MobileNetV2 Mid model from `infinitered/nsfwjs`, MIT.

Thresholds are intentionally high and adult-only consensual sexual content is not a blocking category in TeamoAgent policy code.
