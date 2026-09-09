/**
 * Seeds a hosted Supabase project with the sample people and posts, so a fresh
 * project has something to vote on.
 *
 *   npx tsx scripts/seed-supabase.ts
 *
 * Development only. It creates real auth users with throwaway credentials and
 * writes fixture grid positions directly — those positions are NOT derived from
 * votes, they are stand-ins so alignment has something to compare against. Real
 * users only ever get positions from the vote pipeline.
 *
 * Safe to re-run: existing users and content are skipped.
 */
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { ALL_CONTENT, PEOPLE } from "../src/core/data";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.");
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const emailFor = (handle: string) => `${handle.replace(/[^a-z0-9.]/gi, "")}@pnyx.local`;

async function findUserByEmail(email: string) {
  // listUsers is paginated; the seed set is small enough to scan.
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function main() {
  console.log(`Seeding ${url}\n`);
  const ids = new Map<string, string>(); // sample id -> real uuid

  for (const person of PEOPLE) {
    const email = emailFor(person.handle);
    let user = await findUserByEmail(email);

    if (!user) {
      const { data, error } = await db.auth.admin.createUser({
        email,
        password: randomUUID(),
        email_confirm: true,
        user_metadata: { name: person.name, seed: true },
      });
      if (error) throw new Error(`createUser ${person.handle}: ${error.message}`);
      user = data.user;
      console.log(`  + ${person.handle.padEnd(10)} ${email}`);
    } else {
      console.log(`  = ${person.handle.padEnd(10)} (exists)`);
    }

    ids.set(person.id, user!.id);

    // The signup trigger already made the profile row; fill in the details.
    const { error: pErr } = await db
      .from("profiles")
      .update({
        handle: person.handle,
        name: person.name,
        pronouns: person.pronouns,
        bio: person.bio,
        city: person.city,
        privacy_tier: person.tier,
      })
      .eq("id", user!.id);
    if (pErr) throw new Error(`profile ${person.handle}: ${pErr.message}`);

    // Fixture positions — see the file header.
    const { error: gErr } = await db.from("grid_positions").upsert(
      {
        user_id: user!.id,
        values_x: person.positions.values.x, values_y: person.positions.values.y,
        mind_x: person.positions.mind.x, mind_y: person.positions.mind.y,
        soul_x: person.positions.soul.x, soul_y: person.positions.soul.y,
        culture_x: person.positions.culture.x, culture_y: person.positions.culture.y,
        focus_x: person.positions.focus.x, focus_y: person.positions.focus.y,
        vote_count: person.voteCount,
      },
      { onConflict: "user_id" },
    );
    if (gErr) throw new Error(`positions ${person.handle}: ${gErr.message}`);
  }

  console.log("\nContent:");
  const { data: existing, error: exErr } = await db.from("content").select("body");
  if (exErr) throw new Error(`read content: ${exErr.message}`);
  const seen = new Set((existing ?? []).map((r: { body: string }) => r.body));

  let added = 0;
  for (const item of ALL_CONTENT) {
    if (seen.has(item.text)) continue;
    const authorId = ids.get(item.authorId);
    if (!authorId) continue;

    const { error } = await db.from("content").insert({
      author_id: authorId,
      type: item.type,
      body: item.text,
      context: item.context ?? null,
      music: item.music ?? null,
      scores: item.scores,
      scorer: "seed",
      // Pre-approved so there is something votable without a moderation queue.
      moderation_status: "approved",
      love_count: item.globalSplit.love,
      like_count: item.globalSplit.like,
      dislike_count: item.globalSplit.dislike,
      hate_count: item.globalSplit.hate,
    });
    if (error) throw new Error(`insert content: ${error.message}`);
    added++;
  }
  console.log(`  + ${added} posts (${ALL_CONTENT.length - added} already there)`);

  console.log("\nFollows:");
  let follows = 0;
  for (const person of PEOPLE) {
    for (const other of PEOPLE) {
      if (person.id === other.id || !other.following) continue;
      const { error } = await db
        .from("follows")
        .upsert(
          { follower_id: ids.get(person.id)!, followee_id: ids.get(other.id)! },
          { onConflict: "follower_id,followee_id" },
        );
      if (error) throw new Error(`follow: ${error.message}`);
      follows++;
    }
  }
  console.log(`  + ${follows} edges`);

  console.log("\nDone. Sign up a real account in the app and it will land alongside these.");
}

main().catch((err) => {
  console.error("\nSeed failed:", err.message);
  process.exit(1);
});
