import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({ resetPasswordForEmail:vi.fn(),resend:vi.fn(),getUser:vi.fn(),updateUser:vi.fn(),hasGrant:vi.fn(),clearGrant:vi.fn(),probeSignIn:vi.fn() }));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/server",()=>({ createClient:async()=>({auth:mocks}) }));
// The recovery grant is a cookie, and cookies() has no request scope in a unit
// test. Mocked so each case can state plainly which flow it is: a session that
// arrived through a recovery email, or any other session.
vi.mock("./recovery-grant",()=>({ hasRecoveryPasswordGrant:mocks.hasGrant, clearRecoveryPasswordGrant:mocks.clearGrant }));
// The standalone client updatePasswordAction uses to check the CURRENT
// password without disturbing the caller's own session.
vi.mock("@supabase/supabase-js",()=>({ createClient:()=>({auth:{signInWithPassword:mocks.probeSignIn}}) }));
import { requestPasswordResetAction, updatePasswordAction, resendConfirmationAction } from "./recovery-actions";
const form=(values:Record<string,string>)=>{const result=new FormData(); for(const [key,value] of Object.entries(values)) result.set(key,value); return result;};
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("NEXT_PUBLIC_SITE_URL","https://app.example.com");mocks.resetPasswordForEmail.mockResolvedValue({error:null});mocks.resend.mockResolvedValue({error:null});mocks.getUser.mockResolvedValue({data:{user:{id:"verified-user"}},error:null});mocks.updateUser.mockResolvedValue({error:null});mocks.hasGrant.mockResolvedValue(true);mocks.clearGrant.mockResolvedValue(undefined);mocks.probeSignIn.mockResolvedValue({error:null});});
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
    mocks.hasGrant.mockResolvedValue(false);
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
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: "new-password-one" });
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

describe("the recovery grant is spent on use", () => {
  it("clears the grant after a recovery-flow password change", async () => {
    mocks.hasGrant.mockResolvedValue(true);
    await updatePasswordAction({}, form({ password: "new-password-one", password_confirmation: "new-password-one" }));
    expect(mocks.clearGrant).toHaveBeenCalled();
  });

  it("has no grant to clear on an ordinary verified change", async () => {
    mocks.hasGrant.mockResolvedValue(false);
    mocks.getUser.mockResolvedValue({ data: { user: { id: "u", email: "owner@example.com" } }, error: null });
    await updatePasswordAction({}, form({ password: "new-password-one", password_confirmation: "new-password-one", current_password: "right" }));
    expect(mocks.clearGrant).not.toHaveBeenCalled();
  });
});
