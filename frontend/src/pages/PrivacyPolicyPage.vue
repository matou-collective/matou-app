<template>
  <q-page class="privacy-policy-page">
    <!-- Header -->
    <OnboardingHeader
      title="Privacy Policy"
      subtitle="How we protect and handle your personal information and data"
      :show-back-button="true"
      @back="onBack"
    />

    <div class="max-w-4xl mx-auto p-6 md:p-8">
      <!-- Content -->
      <div class="prose prose-lg max-w-none space-y-6">
        <!-- Introduction -->
        <div>
          <p class="text-sm text-muted-foreground mb-4">
            Last updated: {{ lastUpdated }}
          </p>
          <h2 class="text-2xl font-semibold mb-4">Introduction</h2>
          <section class="bg-card border border-border rounded-xl p-6">
            <p class="text-muted-foreground mb-4">
              At Matou, we are committed to protecting your privacy and ensuring data sovereignty. This Privacy Policy explains how we collect, use, store, and protect your personal information when you use our platform.
            </p>
            <p class="text-muted-foreground">
              As an indigenous-led community focused on data sovereignty and autonomy, we believe that you should have control over your own data. This policy reflects our commitment to these values.
            </p>
          </section>
        </div>

        <!-- Data Sovereignty -->
        <div>
          <h2 class="text-2xl font-semibold mb-4">Data Sovereignty</h2>
          <section class="bg-card border border-border rounded-xl p-6">
            <p class="text-muted-foreground">
              <strong class="text-foreground">You own your data.</strong> Matou is built on principles of data sovereignty, meaning that you maintain ownership and control over your personal information. We provide tools and infrastructure to help you manage your data, but you decide what to share and with whom.
            </p>
          </section>
        </div>

        <!-- Information We Collect -->
        <div>
          <h2 class="text-2xl font-semibold mb-4">Information We Collect</h2>
          <section class="bg-card border border-border rounded-xl p-6">
            <div class="space-y-4">
              <div>
                <h3 class="font-semibold mb-2">Information You Provide</h3>
                <ul class="space-y-2 text-muted-foreground ml-4 list-disc">
                  <li>Profile information (name, email, bio, interests)</li>
                  <li>Content you create or share within the community</li>
                  <li>Communications with other members</li>
                  <li>Governance participation and voting records</li>
                </ul>
              </div>
              <div>
                <h3 class="font-semibold mb-2">Technical Information</h3>
                <ul class="space-y-2 text-muted-foreground ml-4 list-disc">
                  <li>Cryptographic identifiers (AIDs) for identity verification</li>
                  <li>Device and browser information</li>
                  <li>Usage data and analytics (anonymized where possible)</li>
                  <li>Network and connection information</li>
                </ul>
              </div>
            </div>
          </section>
        </div>

        <!-- How We Use Information -->
        <div>
          <h2 class="text-2xl font-semibold mb-4">How We Use Your Information</h2>
          <section class="bg-card border border-border rounded-xl p-6">
            <ul class="space-y-3 text-muted-foreground">
              <li class="flex items-start gap-3">
                <CheckCircle class="w-5 h-5 text-accent shrink-0 mt-0.5" />
                <span>To provide and maintain the Matou platform and services</span>
              </li>
              <li class="flex items-start gap-3">
                <CheckCircle class="w-5 h-5 text-accent shrink-0 mt-0.5" />
                <span>To enable community governance and decision-making</span>
              </li>
              <li class="flex items-start gap-3">
                <CheckCircle class="w-5 h-5 text-accent shrink-0 mt-0.5" />
                <span>To facilitate connections and collaboration between members</span>
              </li>
              <li class="flex items-start gap-3">
                <CheckCircle class="w-5 h-5 text-accent shrink-0 mt-0.5" />
                <span>To improve our services and user experience</span>
              </li>
              <li class="flex items-start gap-3">
                <CheckCircle class="w-5 h-5 text-accent shrink-0 mt-0.5" />
                <span>To ensure platform security and prevent abuse</span>
              </li>
              <li class="flex items-start gap-3">
                <CheckCircle class="w-5 h-5 text-accent shrink-0 mt-0.5" />
                <span>To comply with legal obligations</span>
              </li>
            </ul>
          </section>
        </div>

        <!-- Data Storage and Security -->
        <div>
          <h2 class="text-2xl font-semibold mb-4">Data Storage and Security</h2>
          <section class="bg-card border border-border rounded-xl p-6">
            <div class="space-y-4 text-muted-foreground">
              <p>
                We use decentralized and distributed storage systems to protect your data. Your information is encrypted both in transit and at rest. We implement industry-standard security measures to protect against unauthorized access, alteration, disclosure, or destruction of your personal information.
              </p>
              <p>
                Your cryptographic keys and recovery phrases are stored locally on your device and are never transmitted to our servers. You are responsible for keeping your recovery phrase secure and private.
              </p>
            </div>
          </section>
        </div>

        <!-- Data Sharing -->
        <div>
          <h2 class="text-2xl font-semibold mb-4">Data Sharing</h2>
          <section class="bg-card border border-border rounded-xl p-6">
            <div class="space-y-4 text-muted-foreground">
              <p>
                <strong class="text-foreground">We do not sell any information.</strong> We only share your information:
              </p>
              <ul class="space-y-2 ml-4 list-disc">
                <li>With your explicit request </li>
                <li>If required or approved by the elders council</li>
              </ul>
              <p>
                Profile information you choose to make public will be visible to other community members. You can control the visibility of your information through your profile settings.
              </p>
            </div>
          </section>
        </div>

        <!-- Your Rights -->
        <div>
          <h2 class="text-2xl font-semibold mb-4">Your Rights</h2>
          <section class="bg-card border border-border rounded-xl p-6">
            <p class="text-muted-foreground mb-4">You have the right to:</p>
            <ul class="space-y-2 text-muted-foreground">
              <li class="flex items-start gap-2">
                <span class="text-primary mt-1">&bull;</span>
                <span>Access your personal information</span>
              </li>
              <li class="flex items-start gap-2">
                <span class="text-primary mt-1">&bull;</span>
                <span>Correct inaccurate or incomplete information</span>
              </li>
              <li class="flex items-start gap-2">
                <span class="text-primary mt-1">&bull;</span>
                <span>Request deletion of your personal information</span>
              </li>
              <li class="flex items-start gap-2">
                <span class="text-primary mt-1">&bull;</span>
                <span>Export your data in a portable format</span>
              </li>
              <li class="flex items-start gap-2">
                <span class="text-primary mt-1">&bull;</span>
                <span>Withdraw consent for data processing</span>
              </li>
              <li class="flex items-start gap-2">
                <span class="text-primary mt-1">&bull;</span>
                <span>Object to certain types of data processing</span>
              </li>
            </ul>
          </section>
        </div>

        <!-- Cookies and Tracking -->
        <div>
          <h2 class="text-2xl font-semibold mb-4">Cookies and Tracking</h2>
          <section class="bg-card border border-border rounded-xl p-6">
            <p class="text-muted-foreground">
              We use minimal cookies and tracking technologies necessary for the platform to function. We do not use third-party advertising cookies or tracking for marketing purposes. You can control cookie preferences through your browser settings.
            </p>
          </section>
        </div>

        <!-- Children's Privacy -->
        <div>
          <h2 class="text-2xl font-semibold mb-4">Children's Privacy</h2>
          <section class="bg-card border border-border rounded-xl p-6">
            <p class="text-muted-foreground">
              Matou is not intended for individuals under the age of 18. We do not knowingly collect personal information from children. If you believe we have collected information from a child, please contact us immediately.
            </p>
          </section>
        </div>

        <!-- Changes to Policy -->
        <div>
          <h2 class="text-2xl font-semibold mb-4">Changes to This Policy</h2>
          <section class="bg-card border border-border rounded-xl p-6">
            <p class="text-muted-foreground">
              We may update this Privacy Policy from time to time. Significant changes will be communicated through the community governance process and will be reflected in an updated "Last updated" date. We encourage you to review this policy periodically.
            </p>
          </section>
        </div>

        <!-- Contact -->
        <div>
          <h2 class="text-2xl font-semibold mb-4">Contact Us</h2>
          <section class="bg-card border border-border rounded-xl p-6">
            <p class="text-muted-foreground mb-4">
              If you have questions about this Privacy Policy or wish to exercise your rights regarding your personal information, please contact us through the community governance channels or reach out to administrators.
            </p>
            <p class="text-sm text-muted-foreground">
              For data deletion requests or other privacy-related concerns, please use the appropriate channels in the Matou community platform.
            </p>
          </section>
        </div>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { CheckCircle } from 'lucide-vue-next';
import { useRouter } from 'vue-router';
import OnboardingHeader from 'components/onboarding/OnboardingHeader.vue';

const router = useRouter();
const lastUpdated = new Date().toLocaleDateString();

function onBack() {
  router.back();
}
</script>

<style lang="scss" scoped>
.privacy-policy-page {
  background-color: var(--matou-background);
  min-height: calc(100vh - 36px);
}

h1, h2, h3 {
  color: var(--matou-foreground);
}

.prose {
  h2 {
    margin-top: 2rem;
    margin-bottom: 1rem;
  }
  
  p {
    line-height: 1.7;
  }
}
</style>
