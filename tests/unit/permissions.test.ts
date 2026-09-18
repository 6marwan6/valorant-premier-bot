import { describe, expect, it } from "vitest";
import { isAdmin } from "../../src/discord/permissions.js";

describe("isAdmin", () => {
  it("grants access to a native Discord Administrator, regardless of roles", () => {
    expect(
      isAdmin({ hasAdministratorPermission: true, memberRoleIds: [], adminRoleId: "role-1" }),
    ).toBe(true);
  });

  it("grants access to a member holding the configured admin role", () => {
    expect(
      isAdmin({
        hasAdministratorPermission: false,
        memberRoleIds: ["role-a", "role-b"],
        adminRoleId: "role-b",
      }),
    ).toBe(true);
  });

  it("denies a regular member with no admin permission and no matching role", () => {
    expect(
      isAdmin({
        hasAdministratorPermission: false,
        memberRoleIds: ["role-a"],
        adminRoleId: "role-b",
      }),
    ).toBe(false);
  });

  it("denies everyone when no admin role has been configured yet (pre /setup)", () => {
    expect(
      isAdmin({ hasAdministratorPermission: false, memberRoleIds: ["role-a"], adminRoleId: null }),
    ).toBe(false);
  });

  it("denies a member with an empty role list", () => {
    expect(
      isAdmin({ hasAdministratorPermission: false, memberRoleIds: [], adminRoleId: "role-b" }),
    ).toBe(false);
  });

  it("treats adminRoleId of undefined the same as null (not yet configured)", () => {
    expect(
      isAdmin({ hasAdministratorPermission: false, memberRoleIds: ["role-b"], adminRoleId: undefined }),
    ).toBe(false);
  });
});
