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
export type BillingStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid"
  | "paused";
export type OnboardingTourStatus = "not_started" | "completed" | "skipped";

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
          notification_email_pending: string | null;
          notification_email_pending_token_hash: string | null;
          notification_email_pending_expires_at: string | null;
          logo_url: string | null;
          onboarding_tour_status: OnboardingTourStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          name: string;
          slug: string;
          settings?: Json;
          notification_email?: string | null;
          notification_email_pending?: string | null;
          notification_email_pending_token_hash?: string | null;
          notification_email_pending_expires_at?: string | null;
          logo_url?: string | null;
          onboarding_tour_status?: OnboardingTourStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          name?: string;
          slug?: string;
          settings?: Json;
          notification_email?: string | null;
          notification_email_pending?: string | null;
          notification_email_pending_token_hash?: string | null;
          notification_email_pending_expires_at?: string | null;
          logo_url?: string | null;
          onboarding_tour_status?: OnboardingTourStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      organization_billing: {
        Row: {
          organization_id: number;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          status: BillingStatus;
          trial_ends_at: string | null;
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          grandfathered_at: string | null;
          activated_at: string | null;
          pending_checkout_session_id: string | null;
          checkout_attempt_id: string | null;
          checkout_attempt_interval: string | null;
          checkout_attempt_price_id: string | null;
          checkout_attempt_mode: string | null;
          checkout_attempt_expires_at: string | null;
          checkout_owner_token: string | null;
          checkout_request: Json | null;
          checkout_created_at: string | null;
          reconciliation_lease_owner: string | null;
          reconciliation_lease_expires_at: string | null;
          needs_reconciliation: boolean;
          reconciliation_dirty_since: string | null;
          billing_sync_requested: number;
          billing_sync_completed: number;
          billing_sync_last_attempt_at: string | null;
          billing_sync_last_error: string | null;
          last_synced_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          organization_id: number;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          status?: BillingStatus;
          trial_ends_at?: string | null;
          current_period_end?: string | null;
          cancel_at_period_end?: boolean;
          grandfathered_at?: string | null;
          activated_at?: string | null;
          pending_checkout_session_id?: string | null;
          checkout_attempt_id?: string | null;
          checkout_attempt_interval?: string | null;
          checkout_attempt_price_id?: string | null;
          checkout_attempt_mode?: string | null;
          checkout_attempt_expires_at?: string | null;
          checkout_owner_token?: string | null;
          checkout_request?: Json | null;
          checkout_created_at?: string | null;
          reconciliation_lease_owner?: string | null;
          reconciliation_lease_expires_at?: string | null;
          needs_reconciliation?: boolean;
          reconciliation_dirty_since?: string | null;
          billing_sync_requested?: number;
          billing_sync_completed?: number;
          billing_sync_last_attempt_at?: string | null;
          billing_sync_last_error?: string | null;
          last_synced_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          organization_id?: number;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          status?: BillingStatus;
          trial_ends_at?: string | null;
          current_period_end?: string | null;
          cancel_at_period_end?: boolean;
          grandfathered_at?: string | null;
          activated_at?: string | null;
          pending_checkout_session_id?: string | null;
          checkout_attempt_id?: string | null;
          checkout_attempt_interval?: string | null;
          checkout_attempt_price_id?: string | null;
          checkout_attempt_mode?: string | null;
          checkout_attempt_expires_at?: string | null;
          checkout_owner_token?: string | null;
          checkout_request?: Json | null;
          checkout_created_at?: string | null;
          reconciliation_lease_owner?: string | null;
          reconciliation_lease_expires_at?: string | null;
          needs_reconciliation?: boolean;
          reconciliation_dirty_since?: string | null;
          billing_sync_requested?: number;
          billing_sync_completed?: number;
          billing_sync_last_attempt_at?: string | null;
          billing_sync_last_error?: string | null;
          last_synced_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "organization_billing_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      stripe_webhook_events: {
        Row: {
          id: string;
          created_at: string;
        };
        Insert: {
          id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          created_at?: string;
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
        Returns: number | null;
      };
      finalize_negative_alert_send: {
        Args: {
          p_log_id: number;
          p_delivered: boolean;
        };
        Returns: undefined;
      };
      reserve_notification_email_change: {
        Args: {
          p_organization_id: number;
          p_email: string;
        };
        Returns: number;
      };
      issue_notification_email_change_token: {
        Args: {
          p_log_id: number;
          p_expires_in_minutes?: number;
        };
        Returns: string;
      };
      finalize_notification_email_change_send: {
        Args: {
          p_log_id: number;
          p_delivered: boolean;
        };
        Returns: undefined;
      };
      clear_notification_email: {
        Args: {
          p_organization_id: number;
        };
        Returns: undefined;
      };
      confirm_notification_email_change: {
        Args: {
          p_token: string;
        };
        Returns: number | null;
      };
      claim_checkout_attempt: {
        Args: {
          p_organization_id: number;
          p_interval: string;
          p_price_id: string;
          p_request: Json;
          p_claim_seconds?: number;
        };
        Returns: {
          attempt_id: string;
          owner_token: string | null;
          is_new_attempt: boolean;
          existing_session_id: string | null;
          existing_interval: string | null;
          existing_price_id: string | null;
          existing_mode: string | null;
          request: Json | null;
          retry_safe: boolean;
        }[];
      };
      record_checkout_session: {
        Args: {
          p_organization_id: number;
          p_attempt_id: string;
          p_owner_token: string;
          p_session_id: string;
        };
        Returns: boolean | null;
      };
      finish_checkout_operation: {
        Args: {
          p_organization_id: number;
          p_attempt_id: string;
          p_owner_token: string;
        };
        Returns: boolean | null;
      };
      release_checkout_attempt: {
        Args: {
          p_organization_id: number;
          p_attempt_id: string;
          p_owner_token: string;
        };
        Returns: boolean | null;
      };
      renew_checkout_attempt: {
        Args: {
          p_organization_id: number;
          p_attempt_id: string;
          p_owner_token: string;
          p_claim_seconds?: number;
        };
        Returns: boolean | null;
      };
      request_billing_reconciliation: {
        Args: {
          p_organization_id: number;
        };
        Returns: number;
      };
      claim_reconciliation_lease: {
        Args: {
          p_organization_id: number;
          p_lease_seconds?: number;
        };
        Returns: {
          owner_token: string;
          requested_generation: number;
        }[];
      };
      get_billing_reconciliation_candidates: {
        Args: {
          p_limit?: number;
          p_stale_seconds?: number;
        };
        Returns: {
          organization_id: number;
          stripe_customer_id: string | null;
        }[];
      };
      fail_billing_reconciliation: {
        Args: {
          p_organization_id: number;
          p_owner: string;
          p_error: string;
        };
        Returns: boolean;
      };
      renew_reconciliation_lease: {
        Args: {
          p_organization_id: number;
          p_owner: string;
          p_lease_seconds?: number;
        };
        Returns: boolean | null;
      };
      write_reconciliation_result: {
        Args: {
          p_organization_id: number;
          p_owner: string;
          p_requested_generation: number;
          p_stripe_customer_id: string | null;
          p_stripe_subscription_id: string | null;
          p_status: string;
          p_current_period_end: string | null;
          p_cancel_at_period_end: boolean;
        };
        Returns: boolean;
      };
      write_activation: {
        Args: {
          p_organization_id: number;
          p_owner: string;
          p_requested_generation: number;
        };
        Returns: boolean;
      };
      release_reconciliation_lease: {
        Args: {
          p_organization_id: number;
          p_owner: string;
        };
        Returns: boolean;
      };
      record_billing_anomaly: {
        Args: {
          p_organization_id: number;
          p_kind: string;
          p_detail?: Json;
        };
        Returns: undefined;
      };
      clear_reconciliation_dirty: {
        Args: {
          p_organization_id: number;
          p_owner: string;
          p_requested_generation: number;
        };
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
