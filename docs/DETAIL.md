# Draft polish and templates

Polishes the draft sitting in the input box before you send it, and inserts curated templates at the cursor.

## What the card changes

This card has two list editors rather than a grid of knobs.

- **Role library** — rows of name, emoji, group, description and body, which the input-box Template picker reads. Leaving the table empty is not a disabled state: the plugin then serves its built-in curated set, fetched on demand rather than shipped inside the form description.
- **Import-allowed roots** — additional absolute directories whose role files may be imported. An empty list adds nothing: this card has no session context, so only the bundled `agents/` role library stays importable; the endpoint called with a session also accepts paths inside that session's cwd. Absolute paths outside those zones stay refused. It is not a placeholder waiting to be filled.

Both are read per request, so a change applies on the next action without restarting the host.

## Values that are not on the card

`organizeTimeoutMs` is marked as a live value but has no knob here: the client reads it only to size its own fetch timeout, and the host times out first.

`maxSnippetBytes` and `readConcurrency` are deployment assumptions kept off the card deliberately. Set them in the `config:` block of this plugin's row in `cordis.patch.yml`; they take effect on restart.

## What it needs from outside

No external CLI, interpreter or credential of its own. It uses the host's model runtime and model selection (the live agent's current choice, falling back to the default selection), the session store and the filesystem service; polish follows the model selected for that conversation, so switching the model in the input area changes what the next polish call uses.

## Further detail

The vendored role library, the generated default-template table and the import-scan depth rules are developer-facing and live in the package README (`README.md` / `README.zh-CN.md`).
