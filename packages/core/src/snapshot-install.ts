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
 * Three states rather than two, and every surviving caller requires the same
 * one: a positive `matches`. `adopt`, `claimVariant` and `holdAdopted` ask "may
 * I use this file?"; `stillAdopted` asks "is the file I am handing the caller
 * still the one I pinned?" — and `bootstrapFromSnapshot`'s switch reads
 * anything short of `matches` as "repair anyway", because being wrong in that
 * direction costs one `link` of bytes already on this disk while being wrong in
 * the other leaves a live process serving an empty catalogue.
 *
 * So `differs` and `indeterminate` are no longer told apart by anybody, and
 * that is a deliberate end state rather than an oversight. The one caller that
 * distinguished them was `discardStandIn`, which *destroyed* a file and so
 * needed a positive no; it was removed once `sweepSnapshotFiles` was shown to
 * reclaim the same files on the ordinary retention clock (see `claimVariant`).
 * The distinction is kept in the type because it is what these functions can
 * honestly report — and because collapsing it is exactly what would make the
 * next destructive caller easy to write and wrong: a momentary `EMFILE`, `EIO`
 * or a network mount that blinked while reading a peer's genuine ~230MB
 * snapshot must never read as proof the file is a stand-in.
 */
export type MatchVerdict = 'matches' | 'differs' | 'indeterminate';

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
  try {
    candidate = await open(path, 'r');
    return await sampledHandleVerdict(candidate, tmpPath, size);
  } catch {
    // EMFILE, ENFILE, EACCES, a mount that went away: a file that cannot be
    // opened is a file that cannot be adopted — and equally one that has not
    // been shown to be a stand-in.
    return 'indeterminate';
  } finally {
    await candidate?.close().catch(() => {});
  }
}

/**
 * The sampled comparison, asked of an *already open* candidate.
 *
 * The only difference from `sampledBytesVerdict` is where the candidate comes
 * from, and it is the whole reason this exists separately. A check taken
 * through a *name* establishes something about whatever occupied that name for
 * the instant of the check; the name can resolve to a different file the moment
 * after, and re-opening it to look again only moves the window. A check taken
 * through a descriptor establishes it about the object the descriptor holds,
 * and that object cannot be swapped for as long as the descriptor is open. So
 * this is what binds a pin to verified bytes: see `holdAdopted`.
 */
async function sampledHandleVerdict(
  candidate: FileHandle,
  tmpPath: string,
  size: number,
): Promise<MatchVerdict> {
  let verified: FileHandle | undefined;
  try {
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
 * The file this process adopted, pinned open for as long as the question "is
 * this still the file I adopted?" has to be answerable.
 *
 * The pin is the whole mechanism, not a convenience. An inode number on its own
 * is not an identity across an unlink: ext4 allocates inode numbers from a free
 * list and hands a just-freed one straight back to the next create in the same
 * directory, so a name the sweep unlinked and `initDatabase` recreated
 * microseconds later can come back wearing the number it had before. An *open
 * descriptor* changes that. POSIX frees an inode only when its link count
 * reaches zero **and** no descriptor still refers to it, so while this handle is
 * open the number cannot be recycled — a sweep's `unlink` removes the name but
 * not the object, and any file created at that name afterwards must be given a
 * different one. Held open, the number is an identity; not held, it is a hint.
 *
 * What that buys is a guard that is positive about *replacement* and blind to
 * *content*, which is the exact shape the switch needs: a WAL checkpoint — ours
 * or a peer's — rewrites a live database's bytes in place without touching its
 * inode, and must not be mistaken for a substitution.
 *
 * Costs, all bounded by one `activate`: one descriptor, and — when the sweep
 * really does unlink the file underneath us — the file's blocks stay allocated
 * until `releaseAdopted` runs, because that is precisely what pinning it means.
 *
 * The guard is deliberately not written as though some platform forbade
 * unlinking a file this process holds open. Whether that succeeds varies by
 * platform, filesystem and the share mode every holder used, so assume the
 * substitution can happen anywhere. What holds regardless is the narrower
 * property the guard actually rests on: an open handle keeps the
 * MFT record referenced, so the file ID behind it cannot be recycled, and
 * `stat`'s `ino` on a new file at that name is necessarily different. On a
 * filesystem that reports no meaningful `dev`/`ino` at all it reports the same
 * meaningless pair twice, and the comparison degrades to "the name still
 * resolves to a regular file".
 */
export interface AdoptedFile {
  /** Open for the lifetime of the pin; released only by `releaseAdopted`. */
  readonly handle: FileHandle;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

/**
 * Pin the file at `path` and prove, through the pin, that it is this snapshot.
 *
 * The order is the point, and it is the opposite of the obvious one. `adopt`
 * has already compared this name against `verifiedCopy` — but it did so through
 * the *name*, and between that check and this `open` the name can come to
 * resolve to something else entirely: a sweep pass that read the file's mtime
 * before we claimed it unlinks it, and `initDatabase` in a peer recreates a
 * ~53KB schema-only database at the same name microseconds later. Pinning a
 * file that was verified a moment ago therefore pins whatever is there *now*,
 * and from then on every question the switch asks is answered about the
 * stand-in: identity is stable across `activate` because the stand-in is what
 * was pinned, the guard says `matches`, and the process serves an empty
 * catalogue behind a healthy-looking pointer and digest.
 *
 * So the bytes are checked again here, after the descriptor is in hand and
 * through that descriptor — never by re-opening `path`, which would reintroduce
 * the very window. Once the handle is held the object behind it cannot be
 * swapped, so a comparison taken through it binds the pin to verified bytes for
 * the whole life of the pin. That is what the switch's identity check then
 * carries forward: it says "still the object I pinned", and this says the
 * object I pinned was the snapshot.
 *
 * Null covers all of it — nothing worth handing over is there, it could not be
 * opened at all, or it is not the download in `verifiedCopy`. An `EMFILE`, an
 * `EACCES` and a positive mismatch land here alike, and the caller treats every
 * null the same way: install a file of its own instead. It pays for that with
 * one `link` of bytes already on this disk, and it never destroys anything on
 * the strength of a null, because a pin it never took cannot be evidence about
 * anything.
 *
 * Cost, once per adoption: three 64KB reads of a file the caller is about to
 * open anyway, on a path that has just downloaded or hard-linked ~230MB.
 */
export async function holdAdopted(
  path: string,
  verifiedCopy: string,
): Promise<AdoptedFile | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const s = await handle.stat();
    if (!s.isFile() || s.size === 0) {
      await handle.close().catch(() => {});
      return null;
    }
    // Length first, from the pinned object and the yardstick, exactly as
    // `compareToDownload` asks it — and a yardstick we cannot stat is no
    // yardstick, so it proves nothing and the pin is refused.
    const verified = await fileFacts(verifiedCopy);
    if (verified.kind !== 'file' || verified.size !== s.size) {
      await handle.close().catch(() => {});
      return null;
    }
    if ((await sampledHandleVerdict(handle, verifiedCopy, s.size)) !== 'matches') {
      await handle.close().catch(() => {});
      return null;
    }
    return { handle, dev: s.dev, ino: s.ino };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

/** Drop the pin. Safe to call on every path out, including a throw. */
export async function releaseAdopted(adopted: AdoptedFile): Promise<void> {
  await adopted.handle.close().catch(() => {});
}

/**
 * Does `path` still name the pinned file?
 *
 * `matches` means the name resolves to the very object the pin holds — the file
 * may have been written, checkpointed or grown in the meantime, and this
 * deliberately does not care. `differs` is positive evidence of substitution:
 * the name resolves to a different object, to something that is not a regular
 * file, or to nothing at all, and while the pin is held none of those can be
 * the file it holds. Everything else is `indeterminate` — an `EACCES` on a
 * parent directory, an `EIO`, a mount that blinked — and says nothing either
 * way, which is why the switch repairs on it rather than trusting it.
 *
 * What the pin cannot see is the *contents* of the object it holds, by design:
 * a WAL checkpoint — ours or a peer's — rewrites a live database's bytes in
 * place without touching its identity, and must not read as a substitution.
 * The bytes are established once, through the pin, at `holdAdopted`.
 */
export async function stillAdopted(adopted: AdoptedFile, path: string): Promise<MatchVerdict> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return 'differs';
    return s.dev === adopted.dev && s.ino === adopted.ino ? 'matches' : 'differs';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code && ABSENT_CODES.has(code) ? 'differs' : 'indeterminate';
  }
}
