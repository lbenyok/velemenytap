import { beforeEach, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({ access:vi.fn(), admin:vi.fn(), rpc:vi.fn() }));
vi.mock("./access",()=>({ getPlatformAdmin:m.access }));
vi.mock("@/lib/supabase/admin",()=>({ createAdminClient:m.admin }));
vi.mock("next/cache",()=>({ revalidatePath:vi.fn() }));
import { setModeratorAction } from "./team-actions";
function form() { const f=new FormData(); f.set("email","new@example.invalid");f.set("enabled","true");f.set("actorId","forged");return f; }
beforeEach(()=>{vi.clearAllMocks();m.admin.mockReturnValue({rpc:m.rpc});});
it("refuses moderators and anonymous users before privileged access",async()=>{
  for(const actor of [null,{id:"moderator",platformRole:"moderator"}]) {
    m.access.mockResolvedValue(actor);
    expect((await setModeratorAction({},form())).error).toBeTruthy();
  }
  expect(m.admin).not.toHaveBeenCalled();
});
it("owner action derives the actor and can only request the fixed moderator role",async()=>{
  m.access.mockResolvedValue({id:"owner",platformRole:"owner"});m.rpc.mockResolvedValue({error:null});
  const f=form();f.set("role","owner");
  expect((await setModeratorAction({},f)).success).toBeTruthy();
  expect(m.rpc).toHaveBeenCalledWith("set_platform_moderator",{p_actor_id:"owner",p_email:"new@example.invalid",p_enabled:true});
});
it("explains the verified-account requirement without pretending an invite was sent",async()=>{
  m.access.mockResolvedValue({id:"owner",platformRole:"owner"});m.rpc.mockResolvedValue({error:{code:"P0002"}});
  expect((await setModeratorAction({},form())).error).toContain("erősítse meg");
});
