// Hand-written to match supabase/migrations/20260903150741_core_schema_and_rls.sql.
// Regenerate with `supabase gen types typescript --db-url <url> --schema public`
// once Docker (or an account-level access token) is available, then diff
// against this file before replacing it.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type MembershipRole = "owner" | "admin" | "manager" | "staff";
export type LocationStatus = "active" | "inactive";
export type NfcCardStatus = "active" | "inactive";
export type FeedbackStatus = "new" | "in_progress" | "resolved";

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: number;
          name: string;
          slug: string;
          settings: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          name: string;
          slug: string;
          settings?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          name?: string;
          slug?: string;
          settings?: Json;
          created_at?: string;
          updated_at?: string;
        };
      };
      organization_memberships: {
        Row: {
          id: number;
          organization_id: number;
          user_id: string;
          role: MembershipRole;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          organization_id: number;
          user_id: string;
          role: MembershipRole;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          organization_id?: number;
          user_id?: string;
          role?: MembershipRole;
          created_at?: string;
          updated_at?: string;
        };
      };
      locations: {
        Row: {
          id: number;
          organization_id: number;
          name: string;
          address: string | null;
          google_review_url: string | null;
          status: LocationStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          organization_id: number;
          name: string;
          address?: string | null;
          google_review_url?: string | null;
          status?: LocationStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          organization_id?: number;
          name?: string;
          address?: string | null;
          google_review_url?: string | null;
          status?: LocationStatus;
          created_at?: string;
          updated_at?: string;
        };
      };
      nfc_cards: {
        Row: {
          id: number;
          organization_id: number;
          location_id: number;
          public_id: string;
          display_name: string | null;
          status: NfcCardStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          organization_id: number;
          location_id: number;
          public_id?: string;
          display_name?: string | null;
          status?: NfcCardStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          organization_id?: number;
          location_id?: number;
          public_id?: string;
          display_name?: string | null;
          status?: NfcCardStatus;
          created_at?: string;
          updated_at?: string;
        };
      };
      feedback: {
        Row: {
          id: number;
          organization_id: number;
          location_id: number;
          nfc_card_id: number;
          rating: number;
          feedback_text: string | null;
          status: FeedbackStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          organization_id: number;
          location_id: number;
          nfc_card_id: number;
          rating: number;
          feedback_text?: string | null;
          status?: FeedbackStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          organization_id?: number;
          location_id?: number;
          nfc_card_id?: number;
          rating?: number;
          feedback_text?: string | null;
          status?: FeedbackStatus;
          created_at?: string;
          updated_at?: string;
        };
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
