# Dollar skills

Personal Pi extension; no changes to Pi's installed package.

Run `/reload` after installing or editing. At the start of a prompt, type `$`
to list available skills, then type to filter. Use the native completion menu
keys (up/down, Tab) to choose a skill, add arguments, and submit.
`$skill-name args` delegates to Pi's native `/skill:skill-name args` expansion.
Unknown dollar-prefixed text is unchanged. Slash and file completion delegate
to the original provider. RPC input supports invocation but not the TUI menu.

The extension lives under `~/.pi/agent/extensions/dollar-skills/`, outside
Pi's npm installation, so normal Pi package updates do not overwrite it.
Compatibility with future breaking extension API changes is not guaranteed.

The menu uses Pi's `ctx.ui.addAutocompleteProvider()` API to layer skill
completion over the existing provider, without replacing the editor. This
allows styling extensions such as pi-droid-styling to keep their own editor.
This extension does not modify Pi's source.
