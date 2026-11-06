import type { NoticePurpose } from "../input";

/** Every string a notice language must provide. Tenant values are passed in; templates never evaluate them. */
export interface NoticeStrings {
  title(organisation: string): string;
  banner: string;
  headings: {
    who: string;
    data: string;
    sharing: string;
    rights: string;
    withdraw: string;
    children: string;
    complaint: string;
    about: string;
  };
  who(organisation: string, website: string, dpoName: string | undefined): string[];
  dataIntro: string;
  purposeLines(index: number, purpose: NoticePurpose): string[];
  sharingNone: string;
  sharing(list: string): string;
  rightsIntro: string;
  rights: string[];
  rightsHow(url: string, email: string): string;
  withdraw(url: string): string;
  childrenNo: string;
  childrenYes: string;
  complaint(email: string, address: string): string;
  about: string;
}
