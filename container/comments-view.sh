#!/bin/sh
# The ticket's comments for a prompt (`{{KIT_COMMENTS_VIEW}}`): `comments-view.sh <number>`.
#
# On a public repository anyone with a GitHub account can comment on a queued ticket, and the agent that
# reads the thread holds a token. So only the comments of the repository's owners, members and collaborators
# and of the ticket's author are shown, in the shape `gh issue view N --comments` prints (author, association,
# edited and status lines, then the body between `--` lines), and one last line counts the rest. Every read
# goes through gh-retry.sh, so a GitHub 5xx is retried and a 4xx fails at once, with gh's own words.

here=$(dirname "$0")
n=$1

author=$(sh "$here/gh-retry.sh" api "repos/{owner}/{repo}/issues/$n" --jq '.user.login // ""') || exit
# --paginate prints one array per page; -s joins them.
raw=$(sh "$here/gh-retry.sh" api --paginate "repos/{owner}/{repo}/issues/$n/comments") || exit

printf '%s\n' "$raw" | jq -r -s --arg author "$author" '
  (add // []) as $all
  | ($all | map(select((.author_association | IN("OWNER", "MEMBER", "COLLABORATOR")) or ($author != "" and .user.login == $author)))) as $kept
  | ($kept[] | "author:\t\(.user.login // "ghost")\nassociation:\t\(.author_association | ascii_downcase)\nedited:\t\(.updated_at != .created_at)\nstatus:\tnone\n--\n\(.body // "")\n--"),
    (($all | length) - ($kept | length)) as $out
  | if $out > 0 then "\($out) comment(s) from accounts that are not the repository'"'"'s owners, members or collaborators, or the ticket'"'"'s author, left out" else empty end
'
