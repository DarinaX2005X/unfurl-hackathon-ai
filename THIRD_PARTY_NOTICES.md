# Third-party notices

## Kimi K2.6 chat template

The two-message template in `src/server/ai/kimi-context.ts` is adapted from the Kimi K2.6 chat template published by Moonshot AI. Its tokenizer source informs the conservative UTF-8 byte bound; no tokenizer implementation or vocabulary is bundled by this adaptation.

Upstream revision: `7eb5002f6aadc958aed6a9177b7ed26bb94011bb`.

- [Chat template](https://huggingface.co/moonshotai/Kimi-K2.6/blob/7eb5002f6aadc958aed6a9177b7ed26bb94011bb/chat_template.jinja)
- [Tokenizer source](https://huggingface.co/moonshotai/Kimi-K2.6/blob/7eb5002f6aadc958aed6a9177b7ed26bb94011bb/tokenization_kimi.py)
- [Upstream license](https://huggingface.co/moonshotai/Kimi-K2.6/blob/7eb5002f6aadc958aed6a9177b7ed26bb94011bb/LICENSE)

The following upstream license applies to this third-party material. It does not license this repository as a whole.

```text
Modified MIT License

Copyright (c) 2026 Moonshot AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Our only modification part is that, if the Software (or any derivative works
thereof) is used for any of your commercial products or services that have
more than 100 million monthly active users, or more than 20 million US dollars
(or equivalent in other currencies) in monthly revenue, you shall prominently
display "Kimi K2.6" on the user interface of such product or service.
```
