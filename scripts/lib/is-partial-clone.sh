# BRO-5253: true when the git repo at $1 is a partial (blobless/treeless)
# clone (sparse alone keeps all objects, so it is not counted). A local `git clone` of one has no blobs to hardlink, and the
# checkout then tries to fetch them from the local path and fails.
is_partial_clone() {
  [ -n "$(git -C "$1" config --get remote.origin.promisor 2>/dev/null)" ] ||
    [ -n "$(git -C "$1" config --get extensions.partialclone 2>/dev/null)" ]
}
