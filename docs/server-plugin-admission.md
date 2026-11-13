# Native plugin admission in the hosted trial

This document records an earlier authorized hosted milestone. The current
development goal permits only local public source and authored synthetic data;
production access and reading installed user plugins remain outside its scope.
The narrow admission below still does not constitute a complete native plugin host.

The restored user trial revealed that checking `plugins.length` blocked every
generation, including disabled plugins and a configured plugin whose engine hooks
were inactive. Native admission now follows upstream `enabled` semantics and a
trusted server policy. Unknown enabled plugins still fail before any model request
or message commit.

The only reviewed admission is module-manager v2.2.3, API3.0, exact bundle SHA256
`5aab73060f2448bab14a731caf79c8001d5a8acde51bcbfc80b2d7e593533c5b`, when both
`realArg.global_presets` and `realArg.persona_modules` are exactly empty strings.
Unknown argument keys, changed code/API/name, nonempty bindings, and nonempty or
invalid `pluginCustomStorage.personaInjectedToChar` refuse admission. The reviewed
bundle initializes its persona module map from `persona_modules` and registers
input/display handlers only when that map is nonempty. No copied user plugin source
is stored in this repository.

The server leaves the installed code, enabled flag and arguments intact. It does
not evaluate plugin JavaScript and does not offer a general plugin host. Browser
plugin menus, DOM extensions, configured persona bindings, custom providers and
arbitrary request/output hooks still require their own implementations and tests.
An admitted idle configuration is not evidence those features work.

The policy runs against each job's private restored snapshot, never a value
provided by the HTTP caller. Tests cover changed code/configuration rejection,
disabled-plugin real native execution, and an enabled unknown plugin's rejection
with no provider request or saved messages. The actual saved bundle/configuration
must also be checked on the server before deployment, followed by the user's
designated character in a separate validation chat.

Current user-authorized scope: hosted service and restored backup; direct chat
validation only with `어서오세요, 폐기센터에.`. Other character bodies are excluded;
user reports establish their trial results. The original fifteen acceptance
requirements remain in progress.
