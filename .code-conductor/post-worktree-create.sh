#!/usr/bin/env bash
# Link the main checkout's out-of-tree state into this worktree: the .wiki
# directory and every node_modules directory (root and nested packages).
#
# Run by code-conductor after creating a worktree, with cwd in the new
# worktree. CC_PARENT_PATH is the main checkout's absolute path.

set -e

if [ -z "${CC_PARENT_PATH}" ]; then
    echo "[post-worktree-create] WARNING: CC_PARENT_PATH unset; skipping all symlinks." >&2
    exit 0
fi

# link <relative-path>: symlink ${CC_PARENT_PATH}/<relative-path> to the same path here.
link() {
    local rel="$1" target="${CC_PARENT_PATH}/$1"
    if [ -e "$rel" ] || [ -L "$rel" ]; then
        echo "[post-worktree-create] $rel already exists - skipping symlink."
    elif [ ! -d "$target" ]; then
        echo "[post-worktree-create] WARNING: $target not found; skipping $rel." >&2
    else
        mkdir -p "$(dirname "$rel")"
        ln -s "$target" "$rel"
    fi
}

link .wiki

# Prune .git/.wiki/.worktrees so their contents are never searched, and prune
# each node_modules so nested copies inside it are not picked up.
while IFS= read -r dir; do
    link "${dir#"${CC_PARENT_PATH}"/}"
done < <(find "${CC_PARENT_PATH}" \( -name .git -o -name .wiki -o -name .worktrees \) -prune \
    -o -type d -name node_modules -prune -print)
