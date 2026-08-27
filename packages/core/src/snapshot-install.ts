/**
 * Getting a verified download into place, without ever overwriting a peer.
 *
 * Split out of `snapshot.ts`, which fetches and verifies; this is everything
 * that happens between "the bytes are good" and "the caller can open them".
 * The two halves have separate hazards and separate reasoning, and keeping them
 * apart keeps either file readable: here the whole subject is names — a name a
 * peer already took, a name a peer's journal still owns, a name that came back
 * as something that is not this snapshot at all.
 */
import { link, open, rename, stat, unlink, utimes } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { listDigestVariants, variantDbPath } from './snapshot-state.js';

/** True for a regular file with something in it. */
export async function fileExistsNonEmpty(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/**
 * Inode of a usable file at this path, or null when there is none.
 *
 * The identity, not just the presence: a name can be occupied by a *different*
 * file than the one that was there a moment ago, which is the whole failure this
 * is used to detect. A platform that reports no meaningful inode reports the
 * same meaningless one twice, so the comparison degrades to "still there".
 */
export async function fileIdentity(path: string): Promise<number | bigint | null> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0 ? s.ino : null;
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Errors from `link` that mean "this filesystem has no hard links". */
const NO_HARDLINK_CODES = new Set(['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EMLINK']);

/** Where a verified download ended up, or why it could not be installed. */
export type PromoteOutcome =
  | {
      status: 'ok';
      path: string;
      /**
       * The verified download, still on disk, when `path` names a file this
       * process did **not** create. The caller owns it and must unlink it once
       * it has proved `path` usable — see `adopt`.
       */
      temp?: string;
    }
  | { status: 'failed'; reason: string };

/**
 * Run with the copy already there — once it has proved it is this snapshot,
 * and while keeping ours until the caller has actually opened it.
 *
 * Adoption is what lets a peer skip a second ~230MB download, and until this
 * check it rested entirely on the name: the digest prefix in `data-<sha16>.db`
 * or `data-<sha16>-<rand6>.db` was taken as evidence of the bytes behind it.
 * That evidence is not sound. `initDatabase` recreates any name it is handed —
 * so a variant the sweep took out from under a peer comes back as a ~53KB
 * schema-only database wearing a verified digest in its name, and the next peer
 * to scan for variants would adopt *that* and activate an empty catalogue whose
 * pointer and digest both look perfectly healthy.
 *
 * So the name is no longer the whole claim. The verified download is still in
 * hand at every adoption site, and its length is the snapshot's length, so one
 * `stat` asks the candidate to be exactly that long. Re-hashing 230MB would be
 * proof; this is not, and does not pretend to be. What it is, is the cheapest
 * check that rules out every file that is not this snapshot but could plausibly
 * be sitting at one of these names — a stand-in database, a truncated copy, a
 * different snapshot whose name recurred — because a name is only reused for
 * one digest, and matching its size to the byte as well leaves nothing an
 * attacker-free filesystem can produce by accident.
 *
 * Adoption is also the only outcome that hands back a file this process did
 * *not* create, and therefore the only one that can be taken away again: a
 * `sweepSnapshotFiles` pass in another process may have read that file's mtime
 * before we touched it and be about to unlink it. So the temp file is handed
 * back rather than unlinked, and `bootstrapFromSnapshot` releases it only after
 * the caller has the file open.
 *
 * Returns null when the candidate is absent or is not this snapshot; the caller
 * decides what to do with the name instead.
 */
async function adopt(tmpPath: string, targetPath: string): Promise<PromoteOutcome | null> {
  // Only a positive `matches` adopts: `indeterminate` means we could not read
  // enough to tell, and refusing to adopt costs a second download at worst.
  if ((await compareToDownload(targetPath, tmpPath)) !== 'matches') return null;
  return { status: 'ok', path: targetPath, temp: tmpPath };
}

/**
 * What a comparison against the verified download could actually establish.
 *
 * Three states rather than two, because the two questions callers ask are not
 * each other's negation. `adopt` and `claimVariant` ask "may I use this file?"
 * and must hear yes; `discardStandIn` asks "may I destroy this file?" and must
 * hear a positive no. Collapsing "I could not tell" into `false` answers both
 * at once, and answers one of them wrongly: a momentary `EMFILE`, `EIO` or a
 * network mount that blinked while reading a peer's genuine ~230MB snapshot
 * would read as proof the file is a stand-in, and we would unlink somebody's
 * current database.
 */
type MatchVerdict = 'matches' | 'differs' | 'indeterminate';

/**
 * How `path` compares to the verified download.
 *
 * Two cheap questions, in order. Is it exactly as long? Then do a few windows
 * of its bytes match, sampled at the start, the middle and the end? A file that
 * answers yes to both is this snapshot for every purpose this code has — and a
 * file that gives a *positive* no to either is emphatically not, which is the
 * direction that matters: the whole job here is refusing a stand-in, not
 * certifying bytes a sha256 already certified once.
 *
 * Everything else is `indeterminate`. A `stat` that fails for any reason other
 * than "there is nothing there", a file that will not open, a read that comes
 * back short of what `stat` promised — none of those are evidence about the
 * bytes, and each of them is a thing a healthy filesystem does under load. The
 * verified copy itself is held to the same standard: if *it* cannot be read we
 * hold no yardstick, and a comparison with no yardstick concludes nothing.
 *
 * Length is compared against the temp copy rather than the manifest's
 * `sizeBytes` on purpose: `sizeBytes` describes the *compressed* artifact,
 * while the temp file is the decompressed database whose sha256 was just
 * checked — the only figure on hand that is both free to read and known good.
 * That also means no caller has to pass a manifest in.
 *
 * The sampling is what makes length alone sufficient nowhere and unnecessary
 * nowhere: a schema-only stand-in of coincidentally equal length still differs
 * in its pages, and a file smaller than one window is compared in full. What it
 * is not is a re-verification — 192KB of reads cannot stand in for hashing
 * 230MB, and does not claim to.
 */
async function compareToDownload(path: string, tmpPath: string): Promise<MatchVerdict> {
  const [candidate, verified] = await Promise.all([fileFacts(path), fileFacts(tmpPath)]);
  // Nothing there, or something that is not a regular file: whatever occupies
  // the name, it is not this snapshot, and there is no database to protect.
  if (candidate.kind === 'absent' || candidate.kind === 'other') return 'differs';
  if (candidate.kind === 'unknown' || verified.kind !== 'file') return 'indeterminate';
  if (candidate.size === 0 || candidate.size !== verified.size) return 'differs';
  return sampledBytesVerdict(path, tmpPath, candidate.size);
}

/** How much of the file each sample window covers. */
const SAMPLE_WINDOW_BYTES = 64 * 1024;

/** Window starts for a file of this size — one window when it is small. */
function sampleOffsets(size: number): number[] {
  const last = Math.max(0, size - SAMPLE_WINDOW_BYTES);
  const middle = Math.max(0, Math.floor(size / 2) - Math.floor(SAMPLE_WINDOW_BYTES / 2));
  return [...new Set([0, middle, last])].sort((a, b) => a - b);
}

async function sampledBytesVerdict(
  path: string,
  tmpPath: string,
  size: number,
): Promise<MatchVerdict> {
  let candidate: FileHandle | undefined;
  let verified: FileHandle | undefined;
  try {
    // Sequentially, not `Promise.all`: a rejection there skips the destructuring
    // and leaks whichever handle did open.
    candidate = await open(path, 'r');
    verified = await open(tmpPath, 'r');
    for (const offset of sampleOffsets(size)) {
      const length = Math.min(SAMPLE_WINDOW_BYTES, size - offset);
      const [a, b] = [Buffer.alloc(length), Buffer.alloc(length)];
      const [readA, readB] = await Promise.all([
        candidate.read(a, 0, length, offset),
        verified.read(b, 0, length, offset),
      ]);
      // Shorter than `stat` promised: the file changed under the read, so the
      // bytes we did get say nothing about the file as it now stands.
      if (readA.bytesRead !== length || readB.bytesRead !== length) return 'indeterminate';
      if (!a.equals(b)) return 'differs';
    }
    return 'matches';
  } catch {
    // EMFILE, ENFILE, EIO, EACCES, a mount that went away: a file that cannot
    // be read is a file that cannot be adopted — and equally one that has not
    // been shown to be a stand-in.
    return 'indeterminate';
  } finally {
    await candidate?.close().catch(() => {});
    await verified?.close().catch(() => {});
  }
}

/** What a regular file is, distinguishing "not there" from "could not look". */
type FileFacts =
  | { kind: 'file'; size: number }
  /** `stat` succeeded and it is not a regular file. */
  | { kind: 'other' }
  /** There is demonstrably nothing at this name. */
  | { kind: 'absent' }
  /** `stat` failed for some other reason — no conclusion either way. */
  | { kind: 'unknown' };

/** Codes that mean the name genuinely resolves to nothing. */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

async function fileFacts(path: string): Promise<FileFacts> {
  try {
    const s = await stat(path);
    return s.isFile() ? { kind: 'file', size: s.size } : { kind: 'other' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code && ABSENT_CODES.has(code) ? { kind: 'absent' } : { kind: 'unknown' };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the name has a journal but no database — the footprint of a file
 * the sweep reclaimed while a peer still had it open.
 */
async function hasStrandedSidecars(targetPath: string): Promise<boolean> {
  return (await pathExists(`${targetPath}-wal`)) || (await pathExists(`${targetPath}-shm`));
}

/**
 * Stake a claim on an already-installed variant, or report it unusable.
 *
 * The size check is the same one `adopt` makes, taken *before* the `utimes`
 * rather than after, and that ordering is the point. A stand-in left at a
 * variant name by a swept-then-reopened file is not a snapshot anybody should
 * adopt, and touching it would restart its retention clock on every peer that
 * passed by — a file nothing may use and nothing may ever reclaim. Refusing it
 * here leaves it to age out on the usual grace.
 *
 * The `utimes` on a genuine variant is load-bearing, not cosmetic.
 * `sweepSnapshotFiles` decides purely by mtime, and a variant nobody's pointer
 * names is a sweep candidate the moment it ages past the retention grace —
 * which is precisely the file we are about to start serving from. Touching it
 * restarts that clock — for every sweep that reads the mtime *after* the touch.
 * A pass already under way read it before, so the claim does not bind it: it
 * can unlink the file at any point up to the end of its own directory walk,
 * whatever this function returns. That is why the temp copy is no longer
 * discarded here (see `adopt`).
 */
async function claimVariant(path: string, tmpPath: string): Promise<boolean> {
  // Same standard as `adopt`, and for the same reason: a variant we could not
  // read is a variant we are not going to serve from, so there is nothing to
  // claim. Declining costs one more download; the scan simply moves on.
  if ((await compareToDownload(path, tmpPath)) !== 'matches') return false;
  try {
    const now = new Date();
    await utimes(path, now, now);
    return true;
  } catch {
    return false;
  }
}

/**
 * Promote a verified download to its sha-named home, without ever overwriting.
 *
 * `rename` would happily replace the target, and two installers of the same
 * digest genuinely race here: both see no target, both promote, and the second
 * one strands the first on a ghost inode whose `-wal` no longer belongs to it.
 * `link` cannot do that — it fails with `EEXIST` atomically — so it, not the
 * existence check, is what makes this safe; the check ahead of it only saves a
 * pointless syscall in the common case.
 *
 * Whoever loses adopts the winner's file: same digest, same name, same bytes —
 * and, since the name alone does not prove the bytes, the same length as the
 * copy in hand (see `adopt`). A name occupied by something that is *not* this
 * snapshot is treated as no home at all, exactly like one holding a stranded
 * journal: the install goes to a variant instead of adopting it or overwriting
 * it.
 *
 * Names recur, though: the sweep unlinks a superseded database but deliberately
 * leaves its `-wal`/`-shm` to whichever peer still has that file open, so a
 * digest published again months later can find a journal already sitting at its
 * name. Taking that name would mean opening somebody else's journal as our own.
 * Neither is deleting it an option — it is still in use. So the install goes to
 * a variant name and both databases end up with a journal of their own; the
 * caller is told which name it actually got. Before drawing a fresh suffix,
 * though, both the canonical name and any variant already installed for this
 * digest are checked and adopted if usable — otherwise every peer that meets
 * the same stranded journal pays for its own full copy of identical bytes.
 *
 * Filesystems without hard links (FAT/exFAT volumes, some network mounts) fall
 * back to `rename`, which is atomic but *not* exclusive. There the original
 * race window remains, narrowed to the gap between the check and the rename.
 *
 * Contract: the temp file is consumed only when this call *created* the file it
 * returns. Every path that adopts somebody else's file hands the temp back as
 * `temp` — the caller keeps the verified bytes until the adopted file has
 * actually been opened, and unlinks them then.
 */
export async function promoteDownload(
  tmpPath: string,
  targetPath: string,
): Promise<PromoteOutcome> {
  const installed = await adopt(tmpPath, targetPath);
  if (installed) return installed;
  // Nothing of ours at the canonical name. It is either free — the ordinary
  // first install — or occupied by something that is not this snapshot, and
  // both a stranded journal and a stand-in database make it unusable in
  // exactly the same way.
  const occupied = (await fileExistsNonEmpty(targetPath)) || (await hasStrandedSidecars(targetPath));
  if (!occupied) return promoteTo(tmpPath, targetPath);
  // Re-check the canonical name before committing to a variant: the probe
  // above is check-then-act, and a peer that installed the canonical file
  // inside that window would otherwise leave us writing a *second* full
  // ~230MB copy of identical bytes and pointing the data dir at it. Cheap to
  // narrow; the remaining gap is the few syscalls before `link`.
  const late = await adopt(tmpPath, targetPath);
  if (late) return late;
  // A variant already holding this digest is worth exactly as much as the
  // canonical name would be — same digest in the name, same length as the
  // verified bytes behind it — and nothing else looks for one. Without this
  // scan every peer that finds the stranded sidecars draws its own random
  // suffix and writes an independent ~230MB copy: `data-<sha>-p4kpz3.db` and
  // `data-<sha>-yk9r6t.db` side by side, both current-looking, one of them
  // pure waste.
  //
  // Still check-then-act, like everything else here. The scan can miss a
  // variant a peer is linking into place right now, and two peers that both
  // find nothing still both install — so this removes the *steady-state*
  // duplication, not the millisecond window.
  for (const variant of await listDigestVariants(targetPath)) {
    if (!(await claimVariant(variant, tmpPath))) continue;
    const taken = await adopt(tmpPath, variant);
    if (taken) return taken;
  }
  return promoteTo(tmpPath, variantDbPath(targetPath));
}

export async function promoteTo(tmpPath: string, targetPath: string): Promise<PromoteOutcome> {
  try {
    await link(tmpPath, targetPath);
    // The target now owns the content; the temp name is just a second link.
    await unlink(tmpPath).catch(() => {});
    return { status: 'ok', path: targetPath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // A peer got there first — provided what landed really is this snapshot.
      const adopted = await adopt(tmpPath, targetPath);
      if (adopted) return adopted;
      return { status: 'failed', reason: `target exists but is not this snapshot: ${targetPath}` };
    }
    if (code && NO_HARDLINK_CODES.has(code)) {
      return promoteByRename(tmpPath, targetPath);
    }
    const adopted = await adopt(tmpPath, targetPath);
    if (adopted) return adopted;
    return { status: 'failed', reason: errorMessage(err) };
  }
}

async function promoteByRename(tmpPath: string, targetPath: string): Promise<PromoteOutcome> {
  const installed = await adopt(tmpPath, targetPath);
  if (installed) return installed;
  // `rename` replaces whatever is there, so a name holding a file that is not
  // this snapshot is refused rather than clobbered — the caller's canonical
  // path falls back to a variant, and a variant path is a name only this
  // process has ever drawn.
  if (await fileExistsNonEmpty(targetPath)) {
    return { status: 'failed', reason: `target exists but is not this snapshot: ${targetPath}` };
  }
  try {
    await rename(tmpPath, targetPath);
    return { status: 'ok', path: targetPath };
  } catch (err) {
    const adopted = await adopt(tmpPath, targetPath);
    if (adopted) return adopted;
    return { status: 'failed', reason: errorMessage(err) };
  }
}

/**
 * Unlink the file that took an adopted name — but only once it has proved it
 * is not this snapshot.
 *
 * The name was occupied by the snapshot when it was adopted and is occupied by
 * a different inode now, which in practice means a sweep unlinked it and
 * `initDatabase` recreated it as an empty stand-in. Left there, that stand-in
 * is the poison the size check in `adopt` exists to survive: it wears a
 * verified digest in its name and every later peer would meet it. Removing it
 * closes the hole rather than merely tolerating it — but only when its length
 * says it cannot be the snapshot, because the other way the inode can change is
 * a peer re-installing genuine bytes under a name we happened to share, and
 * that file is somebody's current database.
 *
 * This is the one caller that *destroys* something, so it is the one caller
 * that needs a positive `differs`. "I could not read it" is not that: a
 * momentary `EMFILE`, an `EIO`, a network mount that blinked mid-read of a
 * ~230MB file are all things a busy machine does, and none of them is evidence
 * about the bytes. On an indeterminate answer the file stays exactly where it
 * is and `sweepSnapshotFiles` ages it out on the usual clock if it really was
 * a stand-in — later than we would have liked, which is the safe direction.
 *
 * The database file and nothing else, exactly like `sweepSnapshotFiles`: the
 * `-wal`/`-shm` beside it may belong to a peer that still has the *old* inode
 * open, and unlinking those is the corruption this whole layout prevents.
 */
export async function discardStandIn(path: string, verifiedCopy: string): Promise<void> {
  if ((await compareToDownload(path, verifiedCopy)) !== 'differs') return;
  await unlink(path).catch(() => {});
}

