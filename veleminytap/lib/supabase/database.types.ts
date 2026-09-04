// Hand-written to match supabase/migrations/*.sql (see that directory for
// the current full list). `supabase gen types typescript --db-url <url>
// --schema public` needs Docker/Podman even with --db-url in this CLI
// version, which isn't available in this environment either -- once it is,
// regenerate and diff against this file before replacing it.

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
export type FeedbackPriority = "high" | "medium" | "normal";

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: number;
          name: string;
          slug: string;
          settings: Json;
          notification_email: string | null;
          logo_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          name: string;
          slug: string;
          settings?: Json;
          notification_email?: string | null;
          logo_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          name?: string;
          slug?: string;
          settings?: Json;
          notification_email?: string | null;
          logo_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          full_name: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          full_name?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          full_name?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
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
        Relationships: [
          {
            foreignKeyName: "organization_memberships_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
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
        Relationships: [
          {
            foreignKeyName: "locations_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      nfc_cards: {
        Row: {
          id: number;
          organization_id: number;
          location_id: number;
          public_id: string;
          display_name: string | null;
          status: NfcCardStatus;
          last_negative_alert_at: string | null;
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
          last_negative_alert_at?: string | null;
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
          last_negative_alert_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "nfc_cards_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "nfc_cards_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      feedback: {
        Row: {
          id: number;
          organization_id: number;
          location_id: number;
          nfc_card_id: number;
          rating: number;
          feedback_text: string | null;
          internal_note: string | null;
          status: FeedbackStatus;
          priority: FeedbackPriority;
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
          internal_note?: string | null;
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
          internal_note?: string | null;
          status?: FeedbackStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "feedback_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "feedback_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "feedback_nfc_card_id_fkey";
            columns: ["nfc_card_id"];
            isOneToOne: false;
            referencedRelation: "nfc_cards";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      submit_feedback_atomic: {
        Args: {
          p_public_id: string;
          p_rating: number;
          p_feedback_text: string | null;
        };
        Returns: {
          feedback_id: number;
          organization_id: number;
          organization_name: string;
          location_id: number;
          location_name: string;
          nfc_card_id: number;
          card_name: string | null;
          google_review_url: string | null;
        }[];
      };
      create_organization_atomic: {
        Args: {
          p_name: string;
        };
        Returns: {
          organization_id: number;
          organization_name: string;
          organization_slug: string;
          newly_created: boolean;
        }[];
      };
      get_feedback_overview_snapshot: {
        Args: {
          p_organization_id: number;
        };
        Returns: Json;
      };
      get_feedback_period_analytics: {
        Args: {
          p_organization_id: number;
          p_since: string;
          p_days: number;
        };
        Returns: Json;
      };
      claim_negative_alert_send: {
        Args: {
          p_nfc_card_id: number;
          p_cooldown_minutes?: number;
          p_org_hourly_budget?: number;
        };
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
