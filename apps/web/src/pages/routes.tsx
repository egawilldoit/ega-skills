import type { ReactNode } from "react";
import { Route, Routes } from "react-router-dom";

import { RequirePermission, RequireSession } from "../auth/RequireSession";
import { AppShell } from "../components/AppShell";
import { AuditPage } from "./AuditPage";
import { LoginPage } from "./LoginPage";
import { MembersPage } from "./MembersPage";
import { NotFoundPage } from "./NotFoundPage";
import { OverviewPage } from "./OverviewPage";
import { ProjectDetailPage } from "./ProjectDetailPage";
import { ProjectsPage } from "./ProjectsPage";
import { QuotasPage } from "./QuotasPage";
import { ReleaseComparePage } from "./ReleaseComparePage";
import { ReleaseDetailPage } from "./ReleaseDetailPage";
import { ReleasesPage } from "./ReleasesPage";
import { SecurityPage } from "./SecurityPage";
import { SettingsPage } from "./SettingsPage";
import { SkillDetailPage } from "./SkillDetailPage";
import { SkillsPage } from "./SkillsPage";
import { UsagePage } from "./UsagePage";
import { WorkspaceOverviewPage } from "./WorkspaceOverviewPage";

/**
 * Route table for the console.
 *
 * Ordering note that matters: `/releases/compare` is declared *before*
 * `/releases/:releaseDigest`. React Router also ranks the static segment above
 * the dynamic one regardless of declaration order, but the explicit order
 * documents the intent and survives a future router change.
 *
 * Every protected route is wrapped twice: `RequireSession` for the first-party
 * user session, `RequirePermission` for the resolved workspace role. Neither is
 * an authorization decision — the BFF and the RLS policies remain the authority.
 */
export function AppRoutes(): ReactNode {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <RequireSession>
            <AppShell>
              <Routes>
                <Route
                  path="/"
                  element={
                    <RequirePermission permission="catalog_read">
                      <OverviewPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/skills"
                  element={
                    <RequirePermission permission="catalog_read">
                      <SkillsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/skills/:skillId"
                  element={
                    <RequirePermission permission="catalog_read">
                      <SkillDetailPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/releases"
                  element={
                    <RequirePermission permission="catalog_read">
                      <ReleasesPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/releases/compare"
                  element={
                    <RequirePermission permission="catalog_read">
                      <ReleaseComparePage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/releases/:releaseDigest"
                  element={
                    <RequirePermission permission="catalog_read">
                      <ReleaseDetailPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/projects"
                  element={
                    <RequirePermission permission="projects_read">
                      <ProjectsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/projects/:projectId"
                  element={
                    <RequirePermission permission="projects_read">
                      <ProjectDetailPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/workspace"
                  element={
                    <RequirePermission permission="contexts_read">
                      <WorkspaceOverviewPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/workspace/members"
                  element={
                    <RequirePermission permission="members_read">
                      <MembersPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/workspace/quotas"
                  element={
                    <RequirePermission permission="quotas_read">
                      <QuotasPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/workspace/security"
                  element={
                    <RequirePermission permission="security_read">
                      <SecurityPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/analytics"
                  element={
                    <RequirePermission permission="quotas_read">
                      <UsagePage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/audit"
                  element={
                    <RequirePermission permission="audit_read">
                      <AuditPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/settings"
                  element={
                    <RequirePermission permission="catalog_read">
                      <SettingsPage />
                    </RequirePermission>
                  }
                />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </AppShell>
          </RequireSession>
        }
      />
    </Routes>
  );
}