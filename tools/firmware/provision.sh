#!/bin/sh
# Runs asynchronously on the actual router, never on the build server.
set -eu
umask 077
directory=/etc/kv9-firmware
if [ ! -f /etc/kv9-frpc-packages-ready ]; then
    command -v apk >/dev/null || { logger -t kv9-firmware 'APK is missing; provisioning stopped'; exit 1; }
    if [ -f "$directory/SHA256SUMS" ]; then
        cd "$directory"
        sha256sum -c SHA256SUMS || exit 1
        # Signature checks remain enabled. Exact packages were resolved against the source image.
        set --
        while IFS= read -r package; do
            [ -z "$package" ] || set -- "$@" "$package"
        done < "$directory/constraints"
        [ "$#" -gt 0 ] || exit 1
        apk --repositories-file "$directory/repositories" --no-network add "$@" || exit 1
    fi
    [ -x /usr/bin/frpc ] && [ -x /etc/init.d/frpc ] || exit 1
    touch /etc/kv9-frpc-packages-ready
    rm -rf "$directory/repos"
    rm -f "$directory/SHA256SUMS" "$directory/repositories" "$directory/constraints"
fi
exec /bin/sh /usr/libexec/kv9-frpc-enroll
