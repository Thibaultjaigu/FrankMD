# frozen_string_literal: true

# Registers Requesty (https://requesty.ai) as a RubyLLM provider.
#
# Requesty is an OpenAI-compatible LLM gateway, so it speaks the stock
# Chat Completions protocol. Model ids look like "openai/gpt-4o-mini" and are
# not part of RubyLLM's bundled registry, so any model id is accepted as is.

module RubyLLM
  module Providers
    class Requesty < RubyLLM::Provider
      protocol :chat_completions, RubyLLM::Protocols::ChatCompletions

      def api_base
        "https://router.requesty.ai/v1"
      end

      def headers
        { "Authorization" => "Bearer #{@config.requesty_api_key}" }
      end

      class << self
        def configuration_options
          %i[requesty_api_key]
        end

        def configuration_requirements
          %i[requesty_api_key]
        end

        def assume_models_exist?
          true
        end
      end
    end
  end
end

RubyLLM::Provider.register :requesty, RubyLLM::Providers::Requesty
