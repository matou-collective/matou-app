#!/usr/bin/env bash
#
# patch-libc.sh — produce a seccomp-safe copy of modernc.org/libc for Android.
#
# Issue #98: modernc.org/libc's musl-derived linux/amd64 codegen
# (ccgo_linux_amd64.go) issues *legacy* path syscalls — lstat/stat/unlink/
# rmdir/mkdir/rename/access/chmod/chown/readlink/link/symlink/open. Android's
# app seccomp policy blocks every one of those and only allows the `*at`-family
# equivalents (newfstatat/unlinkat/openat/...). Any legacy call therefore
# SIGSYSes the embedded backend on the android/amd64 emulator. (arm64 real
# devices are unaffected: the arm64 kernel ABI has no legacy path syscalls, so
# musl's arm64 codegen already uses `*at` everywhere.)
#
# This script copies the pinned libc module out of the Go module cache and
# rewrites every legacy call site in ccgo_linux_amd64.go to its `*at`
# equivalent (routed through AT_FDCWD). The `*at` variants are semantically
# identical and have existed since Linux 2.6.16, so the patched module is a
# drop-in for any linux/amd64 target — this only ever gets wired in via a
# build-scoped `replace` for the Android AAR (see the Makefile / build-aar.sh),
# never committed to go.mod, so desktop/server builds are untouched.
#
# The rewrite is data-driven and asserted: each substitution has an expected
# hit count and a final sweep fails loudly if ANY legacy path syscall survives.
# That is deliberate — when modernc.org/libc is bumped and its codegen shifts,
# this script errors instead of silently shipping a crashing AAR. When that
# happens, re-derive the substitutions below against the new ccgo_linux_amd64.go
# (see docs/mobile/ANDROID.md).
#
# Usage: scripts/android/patch-libc.sh [DEST_DIR]
#   DEST_DIR defaults to build/android-libc-patched (relative to backend/).
# Prints the absolute path of the patched module copy on stdout.

set -euo pipefail

# Resolve backend/ regardless of caller cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$BACKEND_DIR"

DEST="${1:-build/android-libc-patched}"

log() { echo "patch-libc: $*" >&2; }

# --- locate the pinned module in the cache ----------------------------------
VERSION="$(go list -m -f '{{.Version}}' modernc.org/libc)"
[ -n "$VERSION" ] || { log "could not resolve modernc.org/libc version"; exit 1; }
log "pinned modernc.org/libc $VERSION"

# `go mod download` guarantees the module is extracted in the cache and gives
# us its on-disk dir directly.
SRC="$(go mod download -json "modernc.org/libc@$VERSION" | grep '"Dir"' | head -1 | sed 's/.*"Dir": *"//; s/".*//')"
[ -n "$SRC" ] && [ -d "$SRC" ] || { log "module cache dir not found for $VERSION"; exit 1; }
log "source: $SRC"

# --- fresh copy (module cache is read-only) ---------------------------------
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
chmod -R u+w "$DEST"

TARGET="$DEST/ccgo_linux_amd64.go"
[ -f "$TARGET" ] || { log "$TARGET missing — libc layout changed, re-derive the patch"; exit 1; }

# --- rewrite legacy syscalls -> *at -----------------------------------------
# Each record is COUNT<TAB>OLD<TAB>NEW. OLD is matched literally (no regex).
# COUNT is the exact number of occurrences that MUST be replaced.
perl - "$TARGET" <<'PERL'
use strict;
use warnings;

my $file = $ARGV[0];
open(my $fh, '<', $file) or die "open $file: $!";
my $src = do { local $/; <$fh> };  # slurp; block-scope $/ so <DATA> stays line-based
close($fh);

my @subs;
while (my $line = <DATA>) {
    chomp $line;
    next if $line eq '' || $line =~ /^#/;
    my ($count, $old, $new) = split /\t/, $line, 3;
    push @subs, [$count, $old, $new];
}

for my $s (@subs) {
    my ($want, $old, $new) = @$s;
    my $n = 0;
    my $pos = 0;
    while ((my $i = index($src, $old, $pos)) >= 0) {
        substr($src, $i, length($old)) = $new;
        $pos = $i + length($new);
        $n++;
    }
    if ($n != $want) {
        die "patch-libc: expected $want occurrence(s) of:\n  $old\nbut replaced $n. ".
            "modernc.org/libc codegen changed — re-derive substitutions.\n";
    }
}

# Final sweep: no legacy path syscall may survive in a call site. The trailing
# ')' keeps this from matching the *at variants (SYS_openat), SYS_renameat)...)
# or unrelated names (SYS_fstat), SYS_newfstatat)).
my @survivors = $src =~ /int64\(SYS_(?:lstat|stat|unlink|rmdir|mkdir|rename|access|chmod|chown|readlink|link|symlink|open)\)/g;
if (@survivors) {
    die "patch-libc: ".scalar(@survivors)." legacy path syscall call site(s) survived ".
        "(e.g. int64(SYS_$survivors[0])) — patch incomplete, re-derive substitutions.\n";
}

open(my $out, '>', $file) or die "write $file: $!";
print $out $src; close($out);
print STDERR "patch-libc: rewrote ".scalar(@subs)." syscall pattern(s) in ccgo_linux_amd64.go\n";

# COUNT<TAB>OLD<TAB>NEW  — see acceptance notes in the header comment.
__DATA__
1	X__syscall2(tls, int64(SYS_stat), int64(bp+144), int64(bp))	X__syscall4(tls, int64(SYS_newfstatat), int64(AT_FDCWD), int64(bp+144), int64(bp), 0)
1	X__syscall2(tls, int64(SYS_lstat), int64(path), int64(bp))	X__syscall4(tls, int64(SYS_newfstatat), int64(AT_FDCWD), int64(path), int64(bp), int64(AT_SYMLINK_NOFOLLOW))
1	X__syscall2(tls, int64(SYS_stat), int64(path), int64(bp))	X__syscall4(tls, int64(SYS_newfstatat), int64(AT_FDCWD), int64(path), int64(bp), 0)
1	X__syscall2(tls, int64(SYS_chmod), int64(path), Int64FromUint32(mode))	X__syscall4(tls, int64(SYS_fchmodat), int64(AT_FDCWD), int64(path), Int64FromUint32(mode), 0)
1	X__syscall2(tls, int64(SYS_chmod), int64(bp), Int64FromUint32(mode))	X__syscall4(tls, int64(SYS_fchmodat), int64(AT_FDCWD), int64(bp), Int64FromUint32(mode), 0)
1	X__syscall2(tls, int64(SYS_mkdir), int64(path), Int64FromUint32(mode))	X__syscall3(tls, int64(SYS_mkdirat), int64(AT_FDCWD), int64(path), Int64FromUint32(mode))
2	X__syscall1(tls, int64(SYS_unlink), int64(path))	X__syscall3(tls, int64(SYS_unlinkat), int64(AT_FDCWD), int64(path), 0)
1	X__syscall1(tls, int64(SYS_unlink), int64(bp))	X__syscall3(tls, int64(SYS_unlinkat), int64(AT_FDCWD), int64(bp), 0)
2	X__syscall1(tls, int64(SYS_rmdir), int64(path))	X__syscall3(tls, int64(SYS_unlinkat), int64(AT_FDCWD), int64(path), int64(AT_REMOVEDIR))
1	X__syscall2(tls, int64(SYS_rename), int64(old), int64(new1))	X__syscall4(tls, int64(SYS_renameat), int64(AT_FDCWD), int64(old), int64(AT_FDCWD), int64(new1))
2	X__syscall3(tls, int64(SYS_readlink), int64(bp+1), int64(bp), int64(Int32FromInt32(1)))	X__syscall4(tls, int64(SYS_readlinkat), int64(AT_FDCWD), int64(bp+1), int64(bp), int64(Int32FromInt32(1)))
1	X__syscall3(tls, int64(SYS_readlink), int64(path), int64(buf), Int64FromUint64(bufsize))	X__syscall4(tls, int64(SYS_readlinkat), int64(AT_FDCWD), int64(path), int64(buf), Int64FromUint64(bufsize))
1	X__syscall2(tls, int64(SYS_access), int64(filename), int64(amode))	X__syscall3(tls, int64(SYS_faccessat), int64(AT_FDCWD), int64(filename), int64(amode))
1	X__syscall3(tls, int64(SYS_chown), int64(path), Int64FromUint32(uid), Int64FromUint32(gid))	X__syscall5(tls, int64(SYS_fchownat), int64(AT_FDCWD), int64(path), Int64FromUint32(uid), Int64FromUint32(gid), 0)
1	X__syscall3(tls, int64(SYS_chown), int64(bp), Int64FromUint32(uid), Int64FromUint32(gid))	X__syscall5(tls, int64(SYS_fchownat), int64(AT_FDCWD), int64(bp), Int64FromUint32(uid), Int64FromUint32(gid), 0)
1	X__syscall2(tls, int64(SYS_link), int64(existing), int64(new1))	X__syscall5(tls, int64(SYS_linkat), int64(AT_FDCWD), int64(existing), int64(AT_FDCWD), int64(new1), 0)
1	X__syscall2(tls, int64(SYS_symlink), int64(existing), int64(new1))	X__syscall3(tls, int64(SYS_symlinkat), int64(existing), int64(AT_FDCWD), int64(new1))
1	___syscall_cp(tls, int64(SYS_open), int64(filename), int64(flags|Int32FromInt32(O_LARGEFILE)), Int64FromUint32(mode), 0, 0, 0)	___syscall_cp(tls, int64(SYS_openat), int64(AT_FDCWD), int64(filename), int64(flags|Int32FromInt32(O_LARGEFILE)), Int64FromUint32(mode), 0, 0)
1	X__syscall2(tls, int64(SYS_open), int64(filename), int64(Int32FromInt32(O_RDONLY)|Int32FromInt32(O_CLOEXEC)|Int32FromInt32(O_LARGEFILE)))	X__syscall3(tls, int64(SYS_openat), int64(AT_FDCWD), int64(filename), int64(Int32FromInt32(O_RDONLY)|Int32FromInt32(O_CLOEXEC)|Int32FromInt32(O_LARGEFILE)))
1	X__syscall3(tls, int64(SYS_open), int64(filename), int64(flags|Int32FromInt32(O_LARGEFILE)), int64(Int32FromInt32(0666)))	X__syscall4(tls, int64(SYS_openat), int64(AT_FDCWD), int64(filename), int64(flags|Int32FromInt32(O_LARGEFILE)), int64(Int32FromInt32(0666)))
1	X__syscall3(tls, int64(SYS_open), int64(bp), int64(Int32FromInt32(O_RDWR)|Int32FromInt32(O_CREAT)|Int32FromInt32(O_EXCL)|Int32FromInt32(O_LARGEFILE)), int64(Int32FromInt32(0600)))	X__syscall4(tls, int64(SYS_openat), int64(AT_FDCWD), int64(bp), int64(Int32FromInt32(O_RDWR)|Int32FromInt32(O_CREAT)|Int32FromInt32(O_EXCL)|Int32FromInt32(O_LARGEFILE)), int64(Int32FromInt32(0600)))
1	X__syscall2(tls, int64(SYS_open), int64(pathname), int64(Int32FromInt32(O_RDONLY)|Int32FromInt32(O_CLOEXEC)|Int32FromInt32(O_NONBLOCK)|Int32FromInt32(O_LARGEFILE)))	X__syscall3(tls, int64(SYS_openat), int64(AT_FDCWD), int64(pathname), int64(Int32FromInt32(O_RDONLY)|Int32FromInt32(O_CLOEXEC)|Int32FromInt32(O_NONBLOCK)|Int32FromInt32(O_LARGEFILE)))
PERL

log "patched module ready at $BACKEND_DIR/$DEST"
echo "$BACKEND_DIR/$DEST"
