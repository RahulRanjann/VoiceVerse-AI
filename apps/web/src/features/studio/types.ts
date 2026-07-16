export interface LanguageOption {
  id: string;
  bcp47Tag: string;
  englishName: string;
  nativeName?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: 'DRAFT' | 'INGESTING' | 'PROCESSING' | 'READY' | 'FAILED' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
  sourceLanguage: LanguageOption;
  targetLanguages: LanguageOption[];
  latestVideo: {
    id: string;
    ingestStatus: 'AWAITING_UPLOAD' | 'UPLOADING' | 'UPLOADED' | 'ABORTED' | 'FAILED';
    securityStatus: 'PENDING' | 'SCANNING' | 'CLEAN' | 'INFECTED' | 'ERROR';
  } | null;
}

export interface ProjectPage {
  data: ProjectSummary[];
  nextCursor: string | null;
}
