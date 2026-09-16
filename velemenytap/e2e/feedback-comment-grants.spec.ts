import { test, expect } from "@playwright/test"
import { createHash, randomBytes } from "node:crypto"
import {
  seedOrgWithMember,
  cleanupOrgWithMember,
  seedActiveCard,
  adminClient,
  userClient,
  type SeededOrgMember,
  type SeededCard,
} from "./support/seed"

/**
 * The database rules behind "save the rating, then maybe add a comment"
 * (migration 20260916100000), driven directly rather than through the page so
 * each rule is checked on its own.
 *
 * feedback rows stay immutable except for ONE transition -- NULL text to a
 * value, once, through attach_feedback_comment, with a live single-use grant.
 */

let org: SeededOrgMember
let card: SeededCard

test.beforeEach(async () => {
  org = await seedOrgWithMember("comment-grants")
  card = await seedActiveCard(org.orgId, "comment-grants")
})

test.afterEach(async () => {
  if (org) await cleanupOrgWithMember(org.userId, org.orgId)
})

const hash = (token: string) => createHash("sha256").update(token).digest("hex")

async function saveRating(rating: number) {
  const admin = adminClient()
  const { data, error } = await admin
    .rpc("submit_feedback_atomic", {
      p_public_id: card.publicId,
      p_rating: rating,
      p_feedback_text: null,
    })
    .single()
  expect(error).toBeNull()
  return data!.feedback_id
}

async function issue(feedbackId: number, ttlSeconds = 1800) {
  const token = randomBytes(32).toString("base64url")
  const { error } = await adminClient().rpc("issue_feedback_comment_grant", {
    p_feedback_id: feedbackId,
    p_token_hash: hash(token),
    p_ttl_seconds: ttlSeconds,
  })
  expect(error).toBeNull()
  return token
}

async function attach(token: string, text: string) {
  const { data, error } = await adminClient().rpc("attach_feedback_comment", {
    p_token_hash: hash(token),
    p_feedback_text: text,
  })
  expect(error).toBeNull()
  return data
}

async function textOf(feedbackId: number) {
  const { data } = await adminClient()
    .from("feedback")
    .select("feedback_text, rating")
    .eq("id", feedbackId)
    .single()
  return data
}

test("a grant attaches a comment once; a replay changes nothing", async () => {
  const id = await saveRating(2)
  const token = await issue(id)

  expect(await attach(token, "Első megjegyzés")).toBe("attached")
  expect(await attach(token, "Felülírási kísérlet")).toBe("used")
  expect(await textOf(id)).toEqual({
    feedback_text: "Első megjegyzés",
    rating: 2,
  })
})

test("concurrent replays of one grant cannot both win", async () => {
  const id = await saveRating(1)
  const token = await issue(id)

  const outcomes = await Promise.all([
    attach(token, "A"),
    attach(token, "B"),
    attach(token, "C"),
  ])
  expect(outcomes.filter((o) => o === "attached")).toHaveLength(1)
  const text = (await textOf(id))?.feedback_text
  expect(["A", "B", "C"]).toContain(text)
})

test("an unknown token, an empty comment, and an expired grant are all refused", async () => {
  const id = await saveRating(3)

  expect(await attach(randomBytes(32).toString("base64url"), "x")).toBe(
    "invalid"
  )

  const token = await issue(id, 1)
  expect(await attach(token, "   ")).toBe("invalid")
  await new Promise((resolve) => setTimeout(resolve, 2000))
  expect(await attach(token, "Túl késő")).toBe("expired")

  expect((await textOf(id))?.feedback_text).toBeNull()
})

test("the trigger still refuses every other change to a saved rating, even from service_role", async () => {
  const id = await saveRating(4)
  const admin = adminClient()

  // Writing text directly, outside attach_feedback_comment.
  const direct = await admin
    .from("feedback")
    .update({ feedback_text: "közvetlen írás" })
    .eq("id", id)
  expect(direct.error).not.toBeNull()

  // Changing the rating.
  const rating = await admin.from("feedback").update({ rating: 5 }).eq("id", id)
  expect(rating.error).not.toBeNull()

  // A comment, once attached, cannot be replaced directly either.
  const token = await issue(id)
  expect(await attach(token, "Eredeti")).toBe("attached")
  const overwrite = await admin
    .from("feedback")
    .update({ feedback_text: "Csere" })
    .eq("id", id)
  expect(overwrite.error).not.toBeNull()
  expect(await textOf(id)).toEqual({ feedback_text: "Eredeti", rating: 4 })
})

test("a grant only ever writes to its own rating", async () => {
  const first = await saveRating(1)
  const second = await saveRating(5)
  const token = await issue(first)

  expect(await attach(token, "Az elsőhöz")).toBe("attached")
  expect((await textOf(first))?.feedback_text).toBe("Az elsőhöz")
  expect((await textOf(second))?.feedback_text).toBeNull()
})

test("an organization member cannot call either function, or read the grants", async () => {
  const id = await saveRating(2)
  const token = await issue(id)
  const member = await userClient(org.email, org.password)

  const attachAttempt = await member.rpc("attach_feedback_comment", {
    p_token_hash: hash(token),
    p_feedback_text: "tag írja",
  })
  expect(attachAttempt.error).not.toBeNull()

  const issueAttempt = await member.rpc("issue_feedback_comment_grant", {
    p_feedback_id: id,
    p_token_hash: hash("forged"),
  })
  expect(issueAttempt.error).not.toBeNull()

  const read = await member.from("feedback_comment_grants" as never).select("*")
  // Either refused outright or empty -- never the row.
  expect(read.data ?? []).toEqual([])

  expect((await textOf(id))?.feedback_text).toBeNull()
})
