import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({ resetPasswordForEmail:vi.fn(),resend:vi.fn(),getUser:vi.fn(),updateUser:vi.fn(),consumeGrant:vi.fn(),reissueGrant:vi.fn(),probeSignIn:vi.fn() }));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/server",()=>({ createClient:async()=>({auth:mocks}) }));
// The recovery grant is a cookie, and cookies() has no request scope in a unit
// test. Mocked so each case can state plainly which flow it is: a session that
// arrived through a recovery email, or any other session.
vi.mock("./recovery-grant",()=>({ consumeRecoveryPasswordGrant:mocks.consumeGrant, reissueRecoveryPasswordGrant:mocks.reissueGrant }));
// The standalone client updatePasswordAction uses to check the CURRENT
// password without disturbing the caller's own session.
vi.mock("@supabase/supabase-js",()=>({ createClient:()=>({auth:{signInWithPassword:mocks.probeSignIn}}) }));
import { requestPasswordResetAction, updatePasswordAction, resendConfirmationAction } from "./recovery-actions";
const form=(values:Record<string,string>)=>{const result=new FormData(); for(const [key,value] of Object.entries(values)) result.set(key,value); return result;};
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("NEXT_PUBLIC_SITE_URL","https://app.example.com");mocks.resetPasswordForEmail.mockResolvedValue({error:null});mocks.resend.mockResolvedValue({error:null});mocks.getUser.mockResolvedValue({data:{user:{id:"verified-user"}},error:null});mocks.updateUser.mockResolvedValue({error:null});mocks.consumeGrant.mockResolvedValue(true);mocks.reissueGrant.mockResolvedValue(undefined);mocks.probeSignIn.mockResolvedValue({error:null});});
afterEach(()=>vi.unstubAllEnvs());
describe("account recovery",()=>{
  it("rejects malformed email without sending",async()=>{expect(await requestPasswordResetAction({},form({email:"bad"}))).toHaveProperty("error");expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();});
  it("normalizes email and uses the fixed PKCE callback",async()=>{expect(await requestPasswordResetAction({},form({email:" OWNER@Example.com "}))).toEqual({success:true});expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith("owner@example.com",{redirectTo:"https://app.example.com/auth/callback?next=/auth/reset-password"});});
  it("does not expose provider details or account existence errors",async()=>{mocks.resetPasswordForEmail.mockResolvedValue({error:{message:"private account information"}});const result=await requestPasswordResetAction({},form({email:"owner@example.com"}));expect(result.success).toBeUndefined();expect(result.error).not.toContain("private");});
  it("refuses an invalid configured redirect origin",async()=>{vi.stubEnv("NEXT_PUBLIC_SITE_URL","javascript:alert(1)");expect(await requestPasswordResetAction({},form({email:"owner@example.com"}))).toHaveProperty("error");expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();});
  it("requires matching passwords before reaching Auth",async()=>{expect(await updatePasswordAction({},form({password:"new-password-one",password_confirmation:"new-password-two"}))).toHaveProperty("error");expect(mocks.getUser).not.toHaveBeenCalled();});
  it("refuses an unauthenticated direct password update",async()=>{mocks.getUser.mockResolvedValue({data:{user:null},error:null});expect(await updatePasswordAction({},form({password:"new-password-one",password_confirmation:"new-password-one"}))).toHaveProperty("error");expect(mocks.updateUser).not.toHaveBeenCalled();});
  it("refuses a failed server-side user verification",async()=>{mocks.getUser.mockResolvedValue({data:{user:{id:"unverified"}},error:{message:"expired"}});expect(await updatePasswordAction({},form({password:"new-password-one",password_confirmation:"new-password-one"}))).toHaveProperty("error");expect(mocks.updateUser).not.toHaveBeenCalled();});
  it("reports success only after Auth accepts the new password",async()=>{expect(await updatePasswordAction({},form({password:"new-password-one",password_confirmation:"new-password-one"}))).toEqual({success:true});expect(mocks.updateUser).toHaveBeenCalledWith({password:"new-password-one"});});
  it("reports update errors without false success",async()=>{mocks.updateUser.mockResolvedValue({error:{message:"requires reauthentication"}});expect(await updatePasswordAction({},form({password:"new-password-one",password_confirmation:"new-password-one"}))).toHaveProperty("error");});
  it("resends confirmation using the fixed signup destination",async()=>{expect(await resendConfirmationAction({},form({email:"owner@example.com"}))).toEqual({success:true});expect(mocks.resend).toHaveBeenCalledWith({type:"signup",email:"owner@example.com",options:{emailRedirectTo:"https://app.example.com/auth/confirm?next=/onboarding"}});});
});

/**
 * The gate that turns "has a session" into "is allowed to replace the password
 * on it". Reproduced end to end before it existed
 * (`e2e/password-change-session-riding.spec.ts`): anyone at an unattended,
 * signed-in browser could set a new password and lock the owner out.
 *
 * The cases above all run with a recovery grant, because that is the flow they
 * were written for. These are the other flow.
 */
describe("password change without a recovery grant", () => {
  const newPassword = { password: "new-password-one", password_confirmation: "new-password-one" };

  beforeEach(() => {
    mocks.consumeGrant.mockResolvedValue(false);
    // currentPasswordIsCorrect needs these to build its throwaway client, and
    // fails closed without them -- see the last case in this block.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  });

  it("refuses when no current password is supplied, without touching Auth", async () => {
    const result = await updatePasswordAction({}, form(newPassword));
    expect(result.error).toBeDefined();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("refuses a blank current password", async () => {
    const result = await updatePasswordAction({}, form({ ...newPassword, current_password: "" }));
    expect(result.error).toBeDefined();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("refuses a wrong current password and never writes", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "u", email: "owner@example.com" } }, error: null });
    mocks.probeSignIn.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    const result = await updatePasswordAction({}, form({ ...newPassword, current_password: "wrong" }));
    expect(result.error).toBeDefined();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("accepts the correct current password", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "u", email: "owner@example.com" } }, error: null });
    const result = await updatePasswordAction({}, form({ ...newPassword, current_password: "right" }));
    expect(result).toEqual({ success: true });
    expect(mocks.probeSignIn).toHaveBeenCalledWith({ email: "owner@example.com", password: "right" });
    // Round-15 R15-01: the proof is forwarded to the provider as well, not just
    // checked here. Verifying locally and omitting it would fail every ordinary
    // change the moment "Require current password" is enabled -- which is the
    // setting that makes this a real boundary rather than a UI-path one.
    expect(mocks.updateUser).toHaveBeenCalledWith({
      password: "new-password-one",
      current_password: "right",
    });
  });

  it("fails closed when the Supabase client cannot be built at all", async () => {
    // Missing configuration must read as "could not verify", never as
    // "verified". This is the one branch where a thrown-away failure would
    // silently restore the original defect.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    mocks.getUser.mockResolvedValue({ data: { user: { id: "u", email: "owner@example.com" } }, error: null });
    const result = await updatePasswordAction({}, form({ ...newPassword, current_password: "right" }));
    expect(result.error).toBeDefined();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("fails closed when the session has no email to verify against", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    const result = await updatePasswordAction({}, form({ ...newPassword, current_password: "right" }));
    expect(result.error).toBeDefined();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});

/**
 * Round-14 R14-01. The action no longer ASKS whether a grant exists and then
 * tidies up afterwards -- it spends one, and the spending is the decision.
 * These pin the two properties that distinguishes that from the forgeable
 * version: the grant is consumed for the caller's own verified user id, and it
 * is consumed exactly once per password change.
 */
describe("the recovery grant is spent, not observed", () => {
  it("consumes the grant for the verified user, not for whoever asked", async () => {
    mocks.consumeGrant.mockResolvedValue(true);
    mocks.getUser.mockResolvedValue({ data: { user: { id: "real-user-id", email: "owner@example.com" } }, error: null });
    await updatePasswordAction({}, form({ password: "new-password-one", password_confirmation: "new-password-one" }));
    expect(mocks.consumeGrant).toHaveBeenCalledWith("real-user-id");
  });

  it("spends at most one grant per password change", async () => {
    mocks.consumeGrant.mockResolvedValue(true);
    await updatePasswordAction({}, form({ password: "new-password-one", password_confirmation: "new-password-one" }));
    expect(mocks.consumeGrant).toHaveBeenCalledTimes(1);
  });

  it("never reaches the grant at all when the session is not verified", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await updatePasswordAction({}, form({ password: "new-password-one", password_confirmation: "new-password-one" }));
    expect(mocks.consumeGrant).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});


/**
 * Round-15 R15-02. The grant is consumed BEFORE Auth is called -- which is what
 * makes it single-use under concurrency -- so a password the provider rejects
 * on its own policy used to spend the customer's only grant and leave them with
 * a retry that asked for the password they had forgotten.
 *
 * The repair is a FRESH grant, never un-spending the old token: restoring
 * `consumed_at` would make a token replayable after an update whose outcome may
 * be unknown.
 */
describe("a provider rejection during recovery", () => {
  const newPassword = { password: "new-password-one", password_confirmation: "new-password-one" };

  beforeEach(() => mocks.consumeGrant.mockResolvedValue(true));

  it("re-issues a grant when the provider definitively refuses the password", async () => {
    mocks.updateUser.mockResolvedValue({ error: { code: "weak_password", message: "too weak" } });
    const result = await updatePasswordAction({}, form(newPassword));
    expect(result.error).toBeDefined();
    expect(mocks.reissueGrant).toHaveBeenCalledWith("verified-user");
    // And the customer is told the link still works, rather than being sent
    // back for another email.
    expect(result.error).toContain("még érvényes");
  });

  it("re-issues on a 422, the status GoTrue uses for validation refusals", async () => {
    mocks.updateUser.mockResolvedValue({ error: { status: 422, message: "validation failed" } });
    await updatePasswordAction({}, form(newPassword));
    expect(mocks.reissueGrant).toHaveBeenCalled();
  });

  it("does NOT re-issue when the outcome is unknown", async () => {
    // A 500 or a transport error may mean the password WAS changed. Handing
    // back a fresh grant there is how replay protection gets given away.
    mocks.updateUser.mockResolvedValue({ error: { status: 500, message: "upstream exploded" } });
    const result = await updatePasswordAction({}, form(newPassword));
    expect(result.error).toBeDefined();
    expect(mocks.reissueGrant).not.toHaveBeenCalled();
    expect(result.error).toContain("Kérj új jelszó-visszaállító e-mailt");
  });

  it("does NOT re-issue for an ordinary session -- it never had a grant to lose", async () => {
    mocks.consumeGrant.mockResolvedValue(false);
    mocks.getUser.mockResolvedValue({ data: { user: { id: "u", email: "owner@example.com" } }, error: null });
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    mocks.updateUser.mockResolvedValue({ error: { code: "weak_password", message: "too weak" } });
    await updatePasswordAction({}, form({ ...newPassword, current_password: "right" }));
    expect(mocks.reissueGrant).not.toHaveBeenCalled();
  });
});

/**
 * Round-15 R15-01. The application-side guard is not the boundary -- the Auth
 * API accepts `updateUser({ password })` from an ordinary session directly
 * (measured). The provider has to enforce it, and the provider needs the proof
 * forwarded; verifying locally and then omitting it would fail every legitimate
 * change once that option is enabled.
 */
describe("the current-password proof reaches the provider", () => {
  const newPassword = { password: "new-password-one", password_confirmation: "new-password-one" };

  it("forwards current_password on the ordinary path", async () => {
    mocks.consumeGrant.mockResolvedValue(false);
    mocks.getUser.mockResolvedValue({ data: { user: { id: "u", email: "owner@example.com" } }, error: null });
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    await updatePasswordAction({}, form({ ...newPassword, current_password: "right" }));
    expect(mocks.updateUser).toHaveBeenCalledWith({
      password: "new-password-one",
      current_password: "right",
    });
  });

  it("does NOT forward it on the recovery path, which cannot know it", async () => {
    mocks.consumeGrant.mockResolvedValue(true);
    await updatePasswordAction({}, form(newPassword));
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: "new-password-one" });
  });
});
