import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell.tsx";
import { EvalDocsPage } from "./pages/EvalDocsPage.tsx";
import { ActivityPage } from "./pages/ActivityPage.tsx";
import { CaseDetailPage } from "./pages/CaseDetailPage.tsx";
import { CasesPage } from "./pages/CasesPage.tsx";
import { ImportedEvaluationPage } from "./pages/ImportedEvaluationPage.tsx";
import { ComparePage } from "./pages/ComparePage.tsx";
import { EvidencePage } from "./pages/EvidencePage.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { ExperimentDetailPage } from "./pages/ExperimentDetailPage.tsx";
import { ExperimentsPage } from "./pages/ExperimentsPage.tsx";
import { NewExperimentPage } from "./pages/NewExperimentPage.tsx";
import { ReviewsPage } from "./pages/ReviewsPage.tsx";
import { RunDetailPage } from "./pages/RunDetailPage.tsx";
import { SystemPage } from "./pages/SystemPage.tsx";
import { ScenariosPage } from "./pages/ScenariosPage.tsx";
import { DiagnosisPage } from "./pages/DiagnosisPage.tsx";
import { AcceptancePage } from "./pages/AcceptancePage.tsx";
import { BenchmarksPage } from "./pages/BenchmarksPage.tsx";
import { BenchmarkDetailPage } from "./pages/BenchmarkDetailPage.tsx";
import { BenchmarkComparePage } from "./pages/BenchmarkComparePage.tsx";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="docs" element={<EvalDocsPage />} />
        <Route path="cases" element={<CasesPage />} />
        <Route path="imported-evaluations" element={<ImportedEvaluationPage />} />
        <Route path="cases/:caseKey" element={<CaseDetailPage />} />
        <Route path="experiments" element={<ExperimentsPage />} />
        <Route path="benchmarks" element={<BenchmarksPage />} />
        <Route path="benchmarks/compare" element={<BenchmarkComparePage />} />
        <Route path="benchmarks/:id" element={<BenchmarkDetailPage />} />
        <Route path="experiments/new" element={<NewExperimentPage />} />
        <Route path="experiments/:id" element={<ExperimentDetailPage />} />
        <Route path="runs/:id" element={<RunDetailPage />} />
        <Route path="reviews" element={<ReviewsPage />} />
        <Route path="compare" element={<ComparePage />} />
        <Route path="evidence" element={<EvidencePage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="scenarios" element={<ScenariosPage />} />
        <Route path="diagnosis" element={<DiagnosisPage />} />
        <Route path="acceptance" element={<AcceptancePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
