/**
 * What counts as evidence that a file is — or is not — this snapshot.
 *
 * Split out of `test-snapshot-adoption.mjs` (which covers what peers do to each
 * other's installed files, and the switch that hands one to the caller) when
 * that file crossed the 1000-line ceiling; the fixtures both use are in
 * `snapshot-concurrency-harness.mjs`. The seam is the subject: nothing here
 * races anything or repairs anything. Every check asks one question about the
 * *rules* — what `adopt` demands before it trusts a file, what `holdAdopted`
 * demands before it pins one as the snapshot, and what the pin can and cannot
 * see afterwards. Nothing here destroys anything, because nothing on this path
 * does any more: the one function that unlinked a file it had not created was
 * removed once the sweep was shown to reclaim the same files on the ordinary
 * retention clock, and the last block here is the evidence for that.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  ageFile,
  bootstrapFromSnapshot,
  dir,
  getServerCount,
  holdAdopted,
  initDatabase,
  payload,
  payloadSha,
  pointerNamesStandIn,
  promoteDownload,
  publishSnapshotState,
  readSnapshotState,
  releaseAdopted,
  reportPassed,
  resolveCurrentDbPath,
  serveOk,
  startOrigin,
  stillAdopted,
  scratch,
  skip,
  sweepSnapshotFiles,
  versionedDbPath,
  writeSnapshotState,
} from './snapshot-concurrency-harness.mjs';

// ─── 1. What a candidate has to match, at snapshot scale ───────────────────

{
  // Length and sampled bytes are one question at the ~53KB scale the shared
  // fixtures work at — a single sampled window covers such a file whole, so
  // length adds nothing on top. At snapshot scale they come apart, so each is
  // asked of a candidate built to pass the other: a file 200KB long,
  // deliberately not a database, because what is under test here is the
  // evidence `adopt` demands and nothing else.
  const body = Buffer.alloc(200 * 1024, 0x61);
  const install = async (name, candidateBytes) => {
    const nominal = scratch(name);
    const folder = join(dir, name);
    const canonical = versionedDbPath(nominal, payloadSha);
    // A stranded journal at the canonical name is what sends an installer to
    // the variant scan in the first place.
    writeFileSync(`${canonical}-wal`, 'still-owned-wal');
    const candidate = join(folder, `data-${payloadSha.slice(0, 16)}-bbbbbb.db`);
    writeFileSync(candidate, candidateBytes);
    ageFile(candidate, 24);
    const download = join(folder, 'data.db.download-999-zzzz');
    writeFileSync(download, body);
    return { candidate, outcome: await promoteDownload(download, canonical) };
  };

  // A truncated copy: every byte it has is the snapshot's, and every window
  // sampled inside it matches, because the offsets are taken from its own
  // length. Only the length itself gives it away.
  const short = await install('adopt-evidence-length', body.subarray(0, body.length - 4096));
  assert.equal(short.outcome.status, 'ok');
  assert.notEqual(
    short.outcome.path,
    short.candidate,
    'a truncated copy that matches everywhere it is sampled is not the snapshot',
  );

  // Identical length, identical opening window, one byte different well past
  // it — which is exactly what a single-window check cannot see.
  const tampered = Buffer.from(body);
  tampered[150 * 1024] = 0x62;
  const inner = await install('adopt-evidence-tail', tampered);
  assert.equal(inner.outcome.status, 'ok');
  assert.notEqual(
    inner.outcome.path,
    inner.candidate,
    'nor is one that differs only past the first sampled window',
  );
  // And once more in the window between the two, which neither of the others
  // reaches — the sample is three windows because two would leave this gap.
  const middled = Buffer.from(body);
  middled[100 * 1024] = 0x62;
  const centre = await install('adopt-evidence-middle', middled);
  assert.equal(centre.outcome.status, 'ok');
  assert.notEqual(
    centre.outcome.path,
    centre.candidate,
    'nor one that differs only between the first window and the last',
  );
  assert.ok(
    Date.now() - statSync(inner.candidate).mtimeMs > 3_600_000,
    'and none of them is claimed on the way past',
  );
}

// ─── 2. The pin, and what it can and cannot see ─────────────────────────────

{
  // The switch's whole guard is one predicate, so it is worth asking directly
  // rather than only through a bootstrap. Each case below is a thing that
  // happens to a name on a live data dir, and the answer the guard has to give.
  const folder = join(dir, 'pin-predicate');
  mkdirSync(folder, { recursive: true });
  const bytes = gunzipSync(payload);
  // The pin is taken against the verified download in hand, always — every
  // caller has one, and pinning without one is what let a stand-in be pinned
  // as trusted. Section 2a is about what that yardstick refuses; here it is
  // satisfied, so the subject is the identity guard alone.
  const yardstick = join(folder, 'data.db.download-000-aaaa');
  writeFileSync(yardstick, bytes);
  const make = async (name) => {
    const path = join(folder, name);
    writeFileSync(path, bytes);
    const pin = await holdAdopted(path, yardstick);
    assert.ok(pin, 'the fixture must be pinnable');
    return { path, pin };
  };

  // The pin is a *held descriptor*, and that is not decoration: it is the only
  // reason the inode number it recorded cannot be handed to some other file
  // while the guard is still going to consult it. Reading through the handle
  // after the name is gone is what proves the object is still alive — a closed
  // handle would fail here, and on a filesystem that recycles eagerly (ext4)
  // the number would then be free for the very file we are trying to detect.
  const held = await make('held-open.db');
  rmSync(held.path);
  const readBack = Buffer.alloc(16);
  const got = await held.pin.handle.read(readBack, 0, 16, 0);
  assert.equal(got.bytesRead, 16, 'the pin must keep the unlinked file readable');
  assert.ok(readBack.equals(bytes.subarray(0, 16)), 'and it must be the file we pinned');
  assert.equal(
    await stillAdopted(held.pin, held.path),
    'differs',
    'a vanished name is a positive no',
  );
  await releaseAdopted(held.pin);

  // A write through the name — the checkpoint case — leaves the file alone.
  const written = await make('written.db');
  writeFileSync(written.path, Buffer.concat([bytes, Buffer.alloc(8192, 7)]));
  assert.equal(
    await stillAdopted(written.pin, written.path),
    'matches',
    'a file that was written to is still the file that was pinned',
  );
  await releaseAdopted(written.pin);

  // Something that is not a regular file took the name. Whatever it is, it is
  // not the database we pinned, and reading its "bytes" is not the question.
  const shadowed = await make('shadowed.db');
  rmSync(shadowed.path);
  mkdirSync(shadowed.path);
  assert.equal(
    await stillAdopted(shadowed.pin, shadowed.path),
    'differs',
    'a directory at the adopted name is a positive no, not a comparison',
  );
  await releaseAdopted(shadowed.pin);
  rmSync(shadowed.path, { recursive: true });

  // The same inode number on a different device is a different file. Data dirs
  // live on one filesystem in every fixture here, so this is asked of the
  // predicate directly rather than staged — but a `~/.mcpfinder` on a mount
  // that went away and came back is exactly where it stops being theoretical.
  const moved = await make('moved.db');
  const elsewhere = { ...moved.pin, dev: moved.pin.dev + 1 };
  assert.equal(
    await stillAdopted(elsewhere, moved.path),
    'differs',
    'the device is part of the identity, not decoration',
  );
  assert.equal(
    await stillAdopted(moved.pin, moved.path),
    'matches',
    'and the real pin still matches',
  );
  await releaseAdopted(moved.pin);

  // Nothing worth handing over is not something to pin: an empty file at the
  // name is the footprint of a create that got no further, and adopting it
  // would hand the caller a database with no schema in it.
  const empty = join(folder, 'empty.db');
  writeFileSync(empty, '');
  assert.equal(await holdAdopted(empty, yardstick), null, 'an empty file is not a file to adopt');
  assert.equal(
    await holdAdopted(join(folder, 'never-existed.db'), yardstick),
    null,
    'nor is a missing one',
  );
}

// ─── 2a. What the pin refuses, and why it is checked after pinning ──────────

{
  // The window this closes: `promoteDownload` verified the candidate's bytes
  // through its *name*, and between that check and the pin's `open` a sweep
  // pass plus a peer's `initDatabase` can leave a different file at the same
  // name. Pinning something already verified pins whatever is there now, and
  // every question afterwards is then answered faithfully about the stand-in —
  // its identity is stable across `activate`, so the switch's guard says
  // `matches` and the process serves an empty catalogue. Verifying *through the
  // pin* is what stops that: the object behind a held descriptor cannot be
  // swapped, so a comparison taken through it binds the pin to verified bytes.
  //
  // The window itself is not reachable from a test: nothing runs between
  // `adopt`'s comparison and `holdAdopted`'s `open` that a fixture can drive —
  // no callback, no name a test controls, only a return and two assignments.
  // Rather than add a seam to production code that exists only for a test, the
  // predicate is asked directly, with the file at the name being exactly what
  // that window would have put there.
  const folder = join(dir, 'pin-evidence');
  mkdirSync(folder, { recursive: true });
  const bytes = gunzipSync(payload);
  const verified = join(folder, 'data.db.download-111-bbbb');
  writeFileSync(verified, bytes);

  const pinnedOrNull = async (name, content, yardstick = verified) => {
    const path = join(folder, name);
    writeFileSync(path, content);
    // A sanity check on the fixture, not on the code: every candidate below is
    // a perfectly openable regular file, which — non-emptiness aside — is all
    // the pin used to ask for.
    closeSync(openSync(path, 'r'));
    const pin = await holdAdopted(path, yardstick);
    if (pin) await releaseAdopted(pin);
    return pin;
  };

  // The schema-only stand-in, in its two shapes: the wrong length, and the
  // right length with different bytes. Both are files the old pin accepted.
  assert.equal(
    await pinnedOrNull('short.db', bytes.subarray(0, bytes.length - 4096)),
    null,
    'a file of the wrong length is not pinned as the snapshot',
  );
  const altered = Buffer.from(bytes);
  altered[Math.floor(bytes.length / 2)] ^= 0xff;
  assert.equal(
    await pinnedOrNull('altered.db', altered),
    null,
    'nor is one that differs only in the middle of its pages',
  );
  const tail = Buffer.from(bytes);
  tail[tail.length - 1] ^= 0xff;
  assert.equal(
    await pinnedOrNull('tail.db', tail),
    null,
    'nor one that differs only at its very end',
  );

  // Two empty files agree on their length and on every byte either of them
  // has, so the yardstick alone would pin one as the snapshot. An empty file at
  // an adopted name is the footprint of a create that got no further, and
  // handing it to the caller is handing over a database with no schema in it.
  writeFileSync(join(folder, 'empty.download'), '');
  assert.equal(
    await pinnedOrNull('empty-vs-empty.db', '', join(folder, 'empty.download')),
    null,
    'an empty file is refused on its own account, not by comparison',
  );

  // No yardstick, no claim. `holdAdopted` is only ever called with the verified
  // download still in hand, and if that copy cannot be read then nothing about
  // the candidate has been established — so the pin is refused and the switch
  // installs a file of its own, which is the cautious direction here.
  assert.equal(
    await pinnedOrNull('unyardsticked.db', bytes, join(folder, 'never-existed.download')),
    null,
    'a pin taken against a yardstick we cannot read establishes nothing',
  );

  // And the genuine article still pins, or the check would be refusing
  // everything and proving nothing.
  const genuine = await holdAdopted(join(folder, 'genuine.db'), verified);
  assert.equal(genuine, null, 'the fixture must not exist yet');
  writeFileSync(join(folder, 'genuine.db'), bytes);
  const good = await holdAdopted(join(folder, 'genuine.db'), verified);
  assert.ok(good, 'a file that really is the snapshot is pinned');
  // The verification went through the descriptor, so it holds the object it
  // measured: the name can go away entirely and the bytes are still readable
  // from the pin.
  rmSync(join(folder, 'genuine.db'));
  const window = Buffer.alloc(32);
  const read = await good.handle.read(window, 0, 32, Math.floor(bytes.length / 2));
  assert.ok(
    window.equals(bytes.subarray(Math.floor(bytes.length / 2), Math.floor(bytes.length / 2) + 32)),
    'and the bytes the pin verified are the bytes the pin holds',
  );
  assert.equal(read.bytesRead, 32);
  await releaseAdopted(good);
}

// ─── 3. A stand-in nobody may use is reclaimed by the sweep, not by us ──────

{
  // Nothing on this path unlinks a file it did not create, and this block is
  // the reason that is safe rather than a leak. There used to be a
  // `discardStandIn` that unlinked the file at an adopted name once the pin and
  // a byte comparison both said it had been substituted — and two positives
  // were still not enough, because a peer re-installing genuine bytes at a
  // variant name we happened to draw answers positively to both: a different
  // inode, and moved bytes, since its own commit checkpoints its WAL into the
  // main file. The cost of being wrong there was a peer's live database.
  //
  // It was introduced only because a stand-in could never age out: every
  // passing peer's `claimVariant` used to `utimes` the candidate *before*
  // judging it, so meeting a stand-in refreshed its retention clock. That
  // ordering is now reversed — a refused candidate is not touched — and this is
  // what that buys: the ordinary clock reclaims it, so the destructive path had
  // nothing left to justify it.
  const nominal = scratch('standin-ages-out');
  const folder = join(dir, 'standin-ages-out');
  const canonical = versionedDbPath(nominal, payloadSha);
  writeFileSync(`${canonical}-wal`, 'still-owned-wal');
  const bytes = gunzipSync(payload);
  const standIn = join(folder, `data-${payloadSha.slice(0, 16)}-ffffff.db`);
  writeFileSync(standIn, bytes.subarray(0, 4096));
  ageFile(standIn, 24 * 30);
  const before = statSync(standIn).mtimeMs;

  const download = join(folder, 'data.db.download-222-cccc');
  writeFileSync(download, bytes);
  const outcome = await promoteDownload(download, canonical);
  assert.equal(outcome.status, 'ok');
  assert.notEqual(outcome.path, standIn, 'the stand-in is refused, not adopted');
  assert.equal(existsSync(standIn), true, 'and refusing it does not destroy it');
  assert.equal(
    statSync(standIn).mtimeMs,
    before,
    'nor is it claimed on the way past — a claim here is what made it immortal',
  );

  await sweepSnapshotFiles(nominal, { retainHours: 24 });
  assert.equal(existsSync(standIn), false, 'the ordinary retention clock is what reclaims it');
}

// ─── 4. An unreadable candidate is not adopted, and not claimed either ──────

{
  // The tri-state where it still costs something: `adopt` must not *trust* an
  // "I could not tell". Serving a file we could not read a single window of would
  // be adoption on the strength of its name alone — the very thing the size
  // and sample checks exist to stop. Declining costs one download.
  const nominal = scratch('adopt-unreadable');
  const folder = join(dir, 'adopt-unreadable');
  const canonical = versionedDbPath(nominal, payloadSha);
  writeFileSync(`${canonical}-wal`, 'still-owned-wal');
  const bytes = gunzipSync(payload);
  const variant = join(folder, `data-${payloadSha.slice(0, 16)}-dddddd.db`);
  writeFileSync(variant, bytes);
  ageFile(variant, 24);
  const before = statSync(variant).mtimeMs;

  chmodSync(variant, 0o000);
  let reallyUnreadable = false;
  try {
    closeSync(openSync(variant, 'r'));
  } catch {
    reallyUnreadable = true;
  }
  if (reallyUnreadable) {
    const download = join(folder, 'data.db.download-888-yyyy');
    writeFileSync(download, bytes);
    const outcome = await promoteDownload(download, canonical);
    chmodSync(variant, 0o600);
    assert.equal(outcome.status, 'ok');
    assert.notEqual(outcome.path, variant, 'a candidate we could not read is not adopted');
    assert.equal(
      statSync(variant).mtimeMs,
      before,
      'nor claimed on the way past — claiming restarts a retention clock on a file we refused',
    );

    // The same refusal at the *canonical* name, which no variant scan gates:
    // there `adopt` is the only thing standing between an unreadable file and
    // the caller opening it as the snapshot.
    const other = scratch('adopt-unreadable-canonical');
    const home = versionedDbPath(other, payloadSha);
    writeFileSync(home, bytes);
    chmodSync(home, 0o000);
    const spare = join(dir, 'adopt-unreadable-canonical', 'data.db.download-777-xxxx');
    writeFileSync(spare, bytes);
    const taken = await promoteDownload(spare, home);
    chmodSync(home, 0o600);
    assert.equal(taken.status, 'ok');
    assert.notEqual(taken.path, home, 'the canonical name is refused on the same evidence');
  } else {
    chmodSync(variant, 0o600);
    skip('EACCES injection needs a non-root user (adopt-unreadable: candidate refusal)');
  }
}

// ─── 5. A pointer is not evidence either: the stand-in wedge ───────────────

{
  // The layer above `adopt`. Everything up to here asks what a *file* has to
  // show before it is trusted; this asks the same of a *pointer*, because the
  // pointer used to be believed for exactly the reason a file used to be —
  // something exists at the name it gives.
  //
  // How the data dir gets here, in one process each: a peer adopts a variant,
  // activates, its guard says the file is still the one it pinned, and it
  // publishes the pointer at it. A sweep pass in a third process that computed
  // `resolveCurrentDbPath` *before* that publish does not know the file is now
  // current, finds it aged and unreferenced, and unlinks it. This process
  // adopted the same file, and its own `activate` — `initDatabase` — puts a
  // schema-only database back at the name. Our pin then correctly reports the
  // substitution and we repair onto a file of our own.
  //
  // Which is where it used to end, wedged: the repair's publish found a
  // non-empty file at the pointer's name, read that as the pointer defending
  // itself, and stood down. From then on every refresh saw a file that exists,
  // a pointer that names it and a digest that matches, and the sweep exempted
  // it at any age for being current. The catalogue served was the 0-server
  // stand-in, permanently, until a new digest was published.
  const nominal = scratch('pointer-standin-wedge');
  const canonical = versionedDbPath(nominal, payloadSha);
  // Exactly what our own `activate` leaves at the swept name: full schema,
  // verified digest in the name, not one server in it.
  initDatabase(canonical).close();
  const when = '2026-08-26T00:00:00.000Z';
  await writeSnapshotState(nominal, {
    dbFile: basename(canonical),
    sha256: payloadSha,
    publishedAt: when,
    // The manifest's figure for these bytes, which is what makes an empty file
    // at this name a demonstrable lie rather than a suspicion.
    serverCount: 1,
    sizeBytes: payload.length,
    installedAt: when,
    checkedAt: when,
  });

  const origin = await startOrigin(serveOk);
  const repaired = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    refresh: true,
    activate: (path) => initDatabase(path).close(),
  });
  await origin.close();

  // Against a tree that trusts existence this is `snapshot-up-to-date`: the
  // digest matches, the file is there, and nothing ever asks it for a server.
  assert.equal(repaired.ok, true, repaired.reason);
  const pointer = await readSnapshotState(nominal);
  assert.notEqual(
    pointer.dbFile,
    basename(canonical),
    'the pointer must not be left naming the stand-in',
  );
  const served = resolveCurrentDbPath(nominal);
  assert.equal(served, repaired.dbPath, 'and the data dir must select the repaired file');
  const db = initDatabase(served);
  assert.equal(getServerCount(db), 1, 'which is the catalogue, not an empty schema');
  db.close();
  // The repair is a repoint, never a delete — the stand-in may be a peer's
  // live database for all this process knows, and the sweep reclaims it on the
  // ordinary clock.
  assert.equal(existsSync(canonical), true, 'the stand-in is replaced, not destroyed');
}

// ─── 6. Each half of that repair, on its own ───────────────────────────────

{
  // The wedge needs two things to be true and block 5 would pass with either
  // one fixed alone for the wrong reason, so both are asked directly here.
  const bytes = gunzipSync(payload);
  const when = '2026-08-26T00:00:00.000Z';
  const pointerFor = (dbFile, extra = {}) => ({
    dbFile,
    sha256: payloadSha,
    publishedAt: when,
    serverCount: 1,
    installedAt: when,
    checkedAt: when,
    ...extra,
  });

  // (a) The publish. Same digest, different file: the tie-break that normally
  // keeps the pointer where it is — repointing at identical bytes only takes
  // the file every peer is serving out of the sweep's protection — must not
  // apply when the file it is keeping the pointer on is a stand-in.
  const wedged = scratch('pointer-standin-publish');
  const standIn = versionedDbPath(wedged, payloadSha);
  initDatabase(standIn).close();
  const ours = join(dir, 'pointer-standin-publish', `data-${payloadSha.slice(0, 16)}-cccccc.db`);
  writeFileSync(ours, bytes);
  await writeSnapshotState(wedged, pointerFor(basename(standIn)));
  const moved = await publishSnapshotState(wedged, pointerFor(basename(ours)));
  assert.equal(moved.status, 'written', 'a pointer on a stand-in defends nothing');

  // And the tie-break is still there for a pointer that has something to
  // defend. This is also the tiny-snapshot case, in the only form where it
  // bites: the fixture snapshot has one server, and SQLite rounds it and the
  // empty stand-in up to the very same number of whole pages — so length
  // cannot tell them apart and the row is the whole difference.
  const healthy = scratch('pointer-genuine-publish');
  const held = versionedDbPath(healthy, payloadSha);
  writeFileSync(held, bytes);
  assert.equal(
    statSync(held).size,
    statSync(standIn).size,
    'the genuine fixture and the stand-in must be the same length, or this proves nothing',
  );
  const twin = join(dir, 'pointer-genuine-publish', `data-${payloadSha.slice(0, 16)}-dddddd.db`);
  writeFileSync(twin, bytes);
  await writeSnapshotState(healthy, pointerFor(basename(held)));
  const kept = await publishSnapshotState(healthy, pointerFor(basename(twin)));
  assert.equal(kept.status, 'superseded', 'a pointer on a real catalogue still wins ties');

  // (b) The freshness check, which is what makes the refresh download at all.
  // Asked of the predicate directly: a bootstrap would answer it only through
  // the reason string it happens to return.
  assert.equal(
    pointerNamesStandIn(wedged, pointerFor(basename(standIn))),
    true,
    'an empty catalogue behind a pointer is positive evidence',
  );
  assert.equal(
    pointerNamesStandIn(healthy, pointerFor(basename(held))),
    false,
    'and a populated one is not accused',
  );

  // What the check declines to judge, stated rather than assumed. A pointer
  // that never recorded a `serverCount` promised nothing, so it keeps the
  // existence-based treatment it had before — the state an older install
  // leaves behind, and one an install repairs on its next publish.
  assert.equal(
    pointerNamesStandIn(wedged, pointerFor(basename(standIn), { serverCount: undefined })),
    false,
    'a pointer with no recorded server count is not accused of anything',
  );
  // Nor is a snapshot genuinely published with no servers in it: by this
  // evidence it is indistinguishable from a stand-in, and it is also not a
  // catalogue anyone can be wedged out of.
  assert.equal(
    pointerNamesStandIn(wedged, pointerFor(basename(standIn), { serverCount: 0 })),
    false,
    'nor a snapshot that promised zero servers',
  );
  // `parseState` validates `sha256` and `dbFile` and nothing else, so the field
  // can hold whatever a hand-edited pointer put there. Anything that is not a
  // positive number is a promise nobody can be caught breaking.
  assert.equal(
    pointerNamesStandIn(wedged, pointerFor(basename(standIn), { serverCount: '25000' })),
    false,
    'nor one whose recorded count is not a number at all',
  );
  // Nor is a file it could not read a single page of: `unknown` is not a
  // verdict, exactly as with `indeterminate` above. Being wrong in this
  // direction leaves the old behaviour; being wrong in the other reinstalls a
  // snapshot on every refresh.
  assert.equal(
    pointerNamesStandIn(wedged, pointerFor('data-never-existed.db')),
    false,
    'nor is a name with nothing at it, which the existence check already covers',
  );
  writeFileSync(join(dir, 'pointer-standin-publish', 'data-garbage.db'), 'not a database at all');
  assert.equal(
    pointerNamesStandIn(wedged, pointerFor('data-garbage.db')),
    false,
    'nor a file that will not open as one',
  );

  // The probe must not change what it probes. A plain read-only open of a
  // WAL-mode database *creates* its `-wal` and `-shm`, and a read-only
  // connection cannot remove them again — and nothing in this design ever
  // deletes a journal, so those would sit at the name for good and send every
  // future install of this digest to a variant. Hence `immutable=1`.
  const untouched = scratch('pointer-probe-sidecars');
  const quiet = versionedDbPath(untouched, payloadSha);
  writeFileSync(quiet, bytes);
  assert.equal(pointerNamesStandIn(untouched, pointerFor(basename(quiet))), false);
  assert.equal(
    existsSync(`${quiet}-wal`) || existsSync(`${quiet}-shm`),
    false,
    'the stand-in probe must not leave a journal behind at the name it probed',
  );
}

reportPassed('snapshot evidence checks');
