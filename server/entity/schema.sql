CREATE TABLE IF NOT EXISTS runtime_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO runtime_meta VALUES ('change_floor', 0);

CREATE TABLE IF NOT EXISTS runtime_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('character', 'group')),
    definition TEXT NOT NULL CHECK (json_valid(definition)),
    trash_time INTEGER,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    metadata TEXT NOT NULL CHECK (json_valid(metadata)),
    revision INTEGER NOT NULL DEFAULT 1,
    content_revision INTEGER NOT NULL DEFAULT 1,
    chat_global_revision INTEGER NOT NULL DEFAULT 0,
    sort_position INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS chats_character ON chats(character_id);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    revision INTEGER NOT NULL DEFAULT 1,
    UNIQUE(chat_id, position)
) STRICT;

CREATE TABLE IF NOT EXISTS chat_variables (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(chat_id, key)
) STRICT;

CREATE TABLE IF NOT EXISTS resources (
    kind TEXT NOT NULL CHECK (kind IN ('module', 'preset', 'settings', 'persona', 'global-variable', 'plugin')),
    id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(kind, id)
) STRICT;

CREATE TABLE IF NOT EXISTS chat_global_variables (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(chat_id, key)
) STRICT;

CREATE TABLE IF NOT EXISTS resource_catalog (
    kind TEXT NOT NULL CHECK (kind IN ('module','preset','persona','plugin')),
    id TEXT NOT NULL,
    summary TEXT NOT NULL CHECK (json_valid(summary)),
    sort_key TEXT NOT NULL,
    namespace TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
    revision INTEGER NOT NULL CHECK (revision > 0),
    entity_epoch INTEGER NOT NULL CHECK (entity_epoch >= 0),
    PRIMARY KEY(kind,id),
    FOREIGN KEY(kind,id) REFERENCES resources(kind,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS resource_catalog_order ON resource_catalog(kind,sort_key,id);
CREATE INDEX IF NOT EXISTS resource_catalog_namespace ON resource_catalog(kind,namespace,id);

CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    extension TEXT NOT NULL,
    mime TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 67108864),
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY REFERENCES commands(id),
    chat_id TEXT NOT NULL,
    chat_epoch INTEGER NOT NULL DEFAULT 0 CHECK (chat_epoch >= 0),
    type TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
    queue_position INTEGER NOT NULL UNIQUE,
    owner TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    started_revision INTEGER,
    started_content_revision INTEGER,
    started_metadata_revision INTEGER,
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    progress TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress)),
    progress_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_running_job_per_chat ON jobs(chat_id) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS job_queue ON jobs(state, queue_position);

CREATE TABLE IF NOT EXISTS changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    chat_id TEXT,
    revision INTEGER,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS bookmark_changes_by_member ON changes(chat_id, entity_id, sequence) WHERE entity_type = 'bookmark';
CREATE TABLE IF NOT EXISTS entity_tombstones (
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY(kind, scope, id)
) STRICT;

-- Derived activity and counters have independent revisions. They do not invalidate
-- the character definitions or generation settings used by another chat job.
CREATE TABLE IF NOT EXISTS character_activity (
    character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    last_interaction INTEGER NOT NULL CHECK (last_interaction >= 0),
    revision INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE TABLE IF NOT EXISTS settings_statistics (
    settings_kind TEXT NOT NULL DEFAULT 'settings' CHECK (settings_kind = 'settings'),
    settings_id TEXT PRIMARY KEY,
    messages INTEGER NOT NULL CHECK (messages >= 0),
    imports INTEGER NOT NULL CHECK (imports >= 0),
    revision INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(settings_kind, settings_id) REFERENCES resources(kind, id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS entity_field_revisions (
    scope TEXT NOT NULL CHECK (scope IN ('character', 'chat', 'resource')),
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    PRIMARY KEY(scope, kind, entity_id, key)
) STRICT;
CREATE TABLE IF NOT EXISTS display_input_clocks (
    scope TEXT NOT NULL CHECK (scope IN ('chat', 'character', 'global')),
    id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    PRIMARY KEY(scope, id)
) STRICT;
CREATE TABLE IF NOT EXISTS display_effects (
    display_key TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    chat_epoch INTEGER NOT NULL CHECK (chat_epoch >= 0),
    input_clock INTEGER NOT NULL CHECK (input_clock >= 0),
    intent_hash TEXT NOT NULL,
    result TEXT NOT NULL CHECK (json_valid(result))
) STRICT;
CREATE INDEX IF NOT EXISTS display_effects_scope ON display_effects(chat_id, chat_epoch, input_clock, display_key);
-- The result of rewriting a source is part of its original display occurrence,
-- never another external input that can recursively admit the same program.
CREATE TABLE IF NOT EXISTS display_message_origins (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    message_revision INTEGER NOT NULL CHECK (message_revision > 0),
    chat_epoch INTEGER NOT NULL CHECK (chat_epoch >= 0),
    character_epoch INTEGER NOT NULL CHECK (character_epoch >= 0),
    input_clock INTEGER NOT NULL CHECK (input_clock >= 0),
    code_hash TEXT NOT NULL,
    display_key TEXT NOT NULL REFERENCES display_effects(display_key) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS chat_bookmarks (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    occurrences INTEGER NOT NULL CHECK (occurrences >= 0),
    sort_position INTEGER NOT NULL,
    name_exists INTEGER NOT NULL CHECK (name_exists IN (0,1)),
    name_json TEXT CHECK (name_json IS NULL OR json_valid(name_json)),
    PRIMARY KEY(chat_id,message_id)
) STRICT;
CREATE INDEX IF NOT EXISTS chat_bookmarks_order ON chat_bookmarks(chat_id,sort_position,message_id) WHERE occurrences>0;
CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    occurrences INTEGER NOT NULL CHECK (occurrences >= 0),
    sort_position INTEGER NOT NULL,
    slots_json TEXT NOT NULL CHECK (json_valid(slots_json)),
    PRIMARY KEY(group_id,member_id)
) STRICT;
CREATE INDEX IF NOT EXISTS group_members_order ON group_members(group_id,sort_position,member_id) WHERE occurrences>0;
CREATE TABLE IF NOT EXISTS job_result_actions (
    source_job_id TEXT PRIMARY KEY REFERENCES jobs(id),
    request_id TEXT NOT NULL UNIQUE REFERENCES commands(id),
    action TEXT NOT NULL CHECK (action IN ('recover','retry')),
    result_job_id TEXT REFERENCES jobs(id),
    created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS reply_choice_sets (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    chat_epoch INTEGER NOT NULL CHECK (chat_epoch >= 0),
    message_id TEXT NOT NULL,
    generation_id TEXT,
    source_job_id TEXT REFERENCES jobs(id),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    selected_position INTEGER NOT NULL DEFAULT 0 CHECK (selected_position >= 0),
    pending_job_id TEXT REFERENCES jobs(id)
) STRICT;
CREATE INDEX IF NOT EXISTS reply_choice_owner ON reply_choice_sets(chat_id,chat_epoch,message_id);
CREATE TABLE IF NOT EXISTS reply_choices (
    set_id TEXT NOT NULL REFERENCES reply_choice_sets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    data TEXT NOT NULL,
    PRIMARY KEY(set_id,position)
) STRICT;
CREATE INDEX IF NOT EXISTS message_generation ON messages(chat_id,json_extract(payload,'$.generationInfo.generationId'));
CREATE TABLE IF NOT EXISTS reply_batch_sets (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    chat_epoch INTEGER NOT NULL CHECK (chat_epoch >= 0),
    prefix_message_id TEXT,
    prefix_count INTEGER NOT NULL CHECK (prefix_count >= 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    selected_position INTEGER NOT NULL DEFAULT 0 CHECK (selected_position >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS reply_batches (
    set_id TEXT NOT NULL REFERENCES reply_batch_sets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    source_job_id TEXT REFERENCES jobs(id),
    PRIMARY KEY(set_id,position)
) STRICT;
CREATE TABLE IF NOT EXISTS reply_batch_messages (
    set_id TEXT NOT NULL,
    batch_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    message_id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    PRIMARY KEY(set_id,batch_position,position),
    UNIQUE(set_id,batch_position,message_id),
    FOREIGN KEY(set_id,batch_position) REFERENCES reply_batches(set_id,position) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS reply_batch_heads (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    set_id TEXT NOT NULL REFERENCES reply_batch_sets(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS job_notices (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    chat_id TEXT NOT NULL,
    chat_epoch INTEGER NOT NULL CHECK (chat_epoch >= 0),
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 128),
    message TEXT NOT NULL,
    message_bytes INTEGER NOT NULL CHECK (message_bytes BETWEEN 0 AND 65536),
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    acknowledged_at INTEGER,
    UNIQUE(job_id,position)
) STRICT;
CREATE INDEX IF NOT EXISTS unread_job_notices ON job_notices(sequence) WHERE acknowledged_at IS NULL;
CREATE TABLE IF NOT EXISTS job_interactions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    chat_id TEXT NOT NULL,
    chat_epoch INTEGER NOT NULL CHECK (chat_epoch >= 0),
    owner TEXT NOT NULL,
    fence INTEGER NOT NULL CHECK (fence > 0),
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 128),
    kind TEXT NOT NULL CHECK (kind IN ('input','select','confirm')),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 0 AND 65536),
    state TEXT NOT NULL CHECK (state IN ('pending','answered','closed')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    answer TEXT CHECK (answer IS NULL OR json_valid(answer)),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    closed_reason TEXT,
    UNIQUE(job_id,position)
) STRICT;
CREATE INDEX IF NOT EXISTS pending_job_interactions ON job_interactions(sequence) WHERE state='pending';
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_job_interaction ON job_interactions(job_id) WHERE state='pending';
CREATE TABLE IF NOT EXISTS job_provider_outputs (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    request INTEGER NOT NULL CHECK (request BETWEEN 1 AND 64),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 0 AND 4194304 AND payload_bytes=length(CAST(payload AS BLOB))),
    PRIMARY KEY(job_id,request)
) STRICT;
CREATE TABLE IF NOT EXISTS plugin_storage_namespaces (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL,
    bundle_sha TEXT NOT NULL CHECK (length(bundle_sha)=64),
    plugin_epoch INTEGER NOT NULL CHECK (plugin_epoch>=0),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision>=0),
    fence INTEGER NOT NULL DEFAULT 0 CHECK (fence>=0),
    writer_id TEXT,
    lease_token TEXT,
    lease_until INTEGER,
    authority TEXT CHECK (authority IS NULL OR json_valid(authority)),
    UNIQUE(plugin_id,bundle_sha,plugin_epoch)
) STRICT;
CREATE TABLE IF NOT EXISTS plugin_storage_items (
    namespace_id TEXT NOT NULL REFERENCES plugin_storage_namespaces(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT CHECK (value IS NULL OR json_valid(value)),
    value_bytes INTEGER NOT NULL DEFAULT 0 CHECK (value_bytes>=0),
    revision INTEGER NOT NULL CHECK (revision>0),
    PRIMARY KEY(namespace_id,key)
) STRICT;
CREATE TABLE IF NOT EXISTS plugin_storage_commits (
    namespace_id TEXT NOT NULL REFERENCES plugin_storage_namespaces(id) ON DELETE CASCADE,
    commit_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result TEXT NOT NULL CHECK (json_valid(result)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(namespace_id,commit_id)
) STRICT;

PRAGMA user_version = 22;
